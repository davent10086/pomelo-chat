export interface VerifyFileInput {
	fileHash?: unknown;
	totalCount?: unknown;
	extname?: unknown;
}
export interface UploadChunkInput {
	chunk?: unknown;
	chunkIndex?: unknown;
	fileHash?: unknown;
	extname?: unknown;
	mime?: unknown;
	uploadToken?: unknown;
}
export interface MergeFileInput {
	fileHash?: unknown;
	extname?: unknown;
	uploadToken?: unknown;
}
import * as repository from './repository';
import type { Actor } from '../../shared/actor';
import { success, failure, type Outcome } from '../../shared/outcome';
import * as fs from 'fs';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { CommonStatus, FileStatus } from '../../shared/status';
import { isAllowedUploadMime, normalizeUploadMetadata } from '../../shared/file';
import { better_chat } from '../../infrastructure/redis';
import { uploadRoot } from '../../infrastructure/file-storage';
import { boundedInteger } from '../../shared/validation';
import { maxUploadBytes, reserveChunk, releaseUploadQuota, withUploadLease, admitUploadSession } from './upload-policy';

const UPLOAD_SESSION_TTL_SECONDS = 60 * 60;
const MAX_CHUNK_COUNT = boundedInteger('MAX_UPLOAD_CHUNKS', 100, 1, 1000);
const MAX_UPLOAD_SIZE = maxUploadBytes;

interface UploadSession {
	totalCount: number;
	uploadToken: string;
}

const uploadSessionKey = (userId: number | string, fileHash: string, ext: string) =>
	`upload:session:${userId}:${fileHash}:${ext}`;

const getUploadPaths = (userId: number | string, fileHash: unknown, extname: unknown) => {
	const metadata = normalizeUploadMetadata(fileHash, extname);
	if (!metadata) return null;
	const dirPath = join(
		uploadRoot,
		String(userId),
		metadata.suffix,
		`${metadata.fileHash}-${metadata.ext}`
	);
	return {
		...metadata,
		dirPath,
		filePath: join(uploadRoot, String(userId), metadata.suffix, `${metadata.fileHash}.${metadata.ext}`),
		fileDBPath: `/uploads/${userId}/${metadata.suffix}/${metadata.fileHash}.${metadata.ext}`
	};
};

const readSession = async (
	userId: number | string,
	paths: NonNullable<ReturnType<typeof getUploadPaths>>,
	token: unknown
): Promise<UploadSession | null> => {
	if (typeof token !== 'string') return null;
	const raw = await better_chat.get(uploadSessionKey(userId, paths.fileHash, paths.ext));
	if (!raw) return null;
	const session = JSON.parse(raw) as Partial<UploadSession>;
	return Number.isInteger(session.totalCount) &&
		session.totalCount! > 0 &&
		typeof session.uploadToken === 'string' &&
		session.uploadToken === token
		? (session as UploadSession)
		: null;
};

const hashFile = async (filePath: string, algorithm: 'md5' | 'sha256'): Promise<string> => {
	const hash = createHash(algorithm);
	await new Promise<void>((resolve, reject) => {
		const stream = fs.createReadStream(filePath);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('end', resolve);
		stream.on('error', reject);
	});
	return hash.digest('hex');
};

/**
 * 检验文件的上传状态：是否已上传、已上传的文件块
 */
const registerFile = async (
	userId: number | string,
	paths: NonNullable<ReturnType<typeof getUploadPaths>>
) => {
	const stat = await fs.promises.stat(paths.filePath);
	if (
		stat.size <= 0 ||
		stat.size > MAX_UPLOAD_SIZE ||
		(await hashFile(paths.filePath, paths.fileHash.length === 64 ? 'sha256' : 'md5')) !==
			paths.fileHash
	)
		throw new Error('Invalid stored upload');
	await repository.upsertReadyFile([
		userId,
		paths.fileHash,
		paths.ext,
		paths.suffix,
		paths.fileDBPath,
		stat.size,
		null
	]);
};

const verifyFileUnlocked = async (actor: Actor, parameters: VerifyFileInput, assertLease: () => Promise<void>): Promise<Outcome> => {
	const { fileHash, totalCount, extname } = parameters || {};
	const paths = getUploadPaths(actor.id, fileHash, extname);
	const count = Number(totalCount);
	if (!paths || !Number.isInteger(count) || count < 1 || count > MAX_CHUNK_COUNT)
		return failure(CommonStatus.PARAM_ERR);
	try {
		const exists = await fs.promises
			.stat(paths.filePath)
			.then(stat => stat.isFile())
			.catch(() => false);
		if (exists) {
			await registerFile(actor.id, paths);
			return success({ neededFileList: [], filePath: paths.fileDBPath }, FileStatus.FILE_EXIST);
		}
		if (!(await admitUploadSession(String(actor.id), `${paths.fileHash}:${paths.ext}`))) return failure(FileStatus.FILE_TOO_LARGE);
		await assertLease();
		await fs.promises.mkdir(paths.dirPath, { recursive: true });
		await fs.promises.writeFile(join(paths.dirPath, '.upload.json'), JSON.stringify({ ext: paths.ext }));
		await repository.markFileUploading([actor.id, paths.fileHash, paths.ext]);
		const key = uploadSessionKey(actor.id, paths.fileHash, paths.ext);
		const candidate = JSON.stringify({ totalCount: count, uploadToken: randomUUID() });
		await better_chat.set(key, candidate, 'EX', UPLOAD_SESSION_TTL_SECONDS, 'NX');
		const session = JSON.parse((await better_chat.get(key)) || candidate) as UploadSession;
		if (session.totalCount !== count) return failure(CommonStatus.PARAM_ERR);
		await better_chat.expire(key, UPLOAD_SESSION_TTL_SECONDS);
		const files = await fs.promises.readdir(paths.dirPath).catch(() => [] as string[]);
		const neededFileList = Array.from({ length: count }, (_, i) => i + 1).filter(
			i => !files.includes('chunk-' + i)
		);
		return success(
			{ neededFileList, uploadToken: session.uploadToken },
			neededFileList.length ? undefined : FileStatus.ALL_CHUNK_UPLOAD
		);
	} catch (err) {
		console.error('[file] verify failed:', err);
		return failure(CommonStatus.SERVER_ERR);
	}
};

export const verifyFile = async (actor: Actor, parameters: VerifyFileInput): Promise<Outcome> => {
	const paths = getUploadPaths(actor.id, parameters?.fileHash, parameters?.extname);
	if (!paths) return failure(CommonStatus.PARAM_ERR);
	try { return await withUploadLease(uploadSessionKey(actor.id, paths.fileHash, paths.ext), assertLease => verifyFileUnlocked(actor, parameters, assertLease)); }
	catch { return failure(CommonStatus.SERVER_ERR); }
};

/**
 * 上传文件块
 */
export const uploadChunk = async (actor: Actor, parameters: UploadChunkInput): Promise<Outcome> => {
	const chunk = parameters.chunk;
	const chunkIndex = Number(parameters.chunkIndex);
	const fileHash = parameters.fileHash;
	const extname = parameters.extname;

	const paths = getUploadPaths(actor.id, fileHash, extname);
	if (
		!paths ||
		!Number.isInteger(chunkIndex) ||
		chunkIndex < 1 ||
		!Buffer.isBuffer(chunk) || chunk.length < 1 || chunk.length > 10 * 1024 * 1024 ||
		!isAllowedUploadMime(parameters.mime)
	) {
		return failure(CommonStatus.PARAM_ERR);
	}
	const session = await readSession(actor.id, paths, parameters.uploadToken).catch(() => null);
	if (!session || chunkIndex > session.totalCount) return failure(CommonStatus.PARAM_ERR);
	const { dirPath } = paths;
	const chunkPath = join(dirPath, `chunk-${chunkIndex}`);

	try {
		return await withUploadLease(uploadSessionKey(actor.id, paths.fileHash, paths.ext), async assertLease => {
			if (!(await readSession(actor.id, paths, parameters.uploadToken))) return failure(CommonStatus.PARAM_ERR);
			await assertLease();
			const previous = await reserveChunk(String(actor.id), `${paths.fileHash}:${paths.ext}`, chunkIndex, (chunk as Buffer).length);
			if (previous < 0) return failure(FileStatus.FILE_TOO_LARGE);
			let written = false;
			const temporaryChunk = `${chunkPath}.part-${randomUUID()}`;
			try {
		const hasDir = await fs.promises
			.access(dirPath)
			.then(() => true)
			.catch(() => false);

		if (!hasDir) {
			await fs.promises.mkdir(dirPath, { recursive: true });
		}

		await fs.promises.writeFile(temporaryChunk, chunk as Buffer);
		await assertLease();
		await fs.promises.rename(temporaryChunk, chunkPath);
		written = true;
		await better_chat.expire(uploadSessionKey(actor.id, paths.fileHash, paths.ext), UPLOAD_SESSION_TTL_SECONDS);
		await admitUploadSession(String(actor.id), `${paths.fileHash}:${paths.ext}`);

		return success();
			} catch (error) {
				await fs.promises.rm(temporaryChunk, { force: true }).catch(() => undefined);
				// Once bytes are on disk their reservation remains, even if lease renewal fails.
				if (!written) {
					try { await assertLease(); await reserveChunk(String(actor.id), `${paths.fileHash}:${paths.ext}`, chunkIndex, previous); } catch { /* A new owner controls accounting; preserve the conservative reservation. */ }
				}
				throw error;
			}
		});
	} catch {
		return failure(CommonStatus.SERVER_ERR);
	}
};

/**
 * 合并文件
 */
const mergeFileUnlocked = async (actor: Actor, parameters: MergeFileInput, assertLease: () => Promise<void>): Promise<Outcome> => {
	const { fileHash, extname } = parameters || {};
	if (!fileHash || !extname) {
		return failure(CommonStatus.PARAM_ERR);
	}
	const paths = getUploadPaths(actor.id, fileHash, extname);
	if (!paths) {
		return failure(CommonStatus.PARAM_ERR);
	}
	const session = await readSession(actor.id, paths, parameters.uploadToken).catch(() => null);
	if (!session) return failure(CommonStatus.PARAM_ERR);
	const { dirPath, filePath, fileDBPath } = paths;

	try {
		// 检查文件是否已存在
		await fs.promises.access(filePath);
		await registerFile(actor.id, paths);
		const data = { message: '文件已存在', filePath: fileDBPath };
		return success(data);
	} catch {
		// 文件不存在，继续执行
	}

	const lockPath = `${filePath}.merge.lock`;
	const tempPath = `${filePath}.part-${randomUUID()}`;
	let lockAcquired = false;
	try {
		const lock = await fs.promises.open(lockPath, 'wx');
		await lock.close();
		lockAcquired = true;
		const files = (await fs.promises.readdir(dirPath)).filter(name => /^chunk-\d+$/.test(name));
		if (
			files.length !== session.totalCount ||
			!Array.from({ length: session.totalCount }, (_, index) =>
				files.includes(`chunk-${index + 1}`)
			).every(Boolean)
		)
			throw new Error('incomplete upload chunks');
		const sizes = await Promise.all(files.map(name => fs.promises.stat(join(dirPath, name))));
		if (sizes.reduce((total, stat) => total + stat.size, 0) > MAX_UPLOAD_SIZE) return failure(FileStatus.FILE_TOO_LARGE);
		for (let index = 1; index <= session.totalCount; index++) {
			await assertLease();
			await pipeline(
				fs.createReadStream(join(dirPath, `chunk-${index}`)),
				fs.createWriteStream(tempPath, { flags: index === 1 ? 'w' : 'a' })
			);
		}
		const stat = await fs.promises.stat(tempPath);
		if (stat.size <= 0 || stat.size > MAX_UPLOAD_SIZE) throw new Error('invalid upload size');
		const algorithm = paths.fileHash.length === 64 ? 'sha256' : 'md5';
		if ((await hashFile(tempPath, algorithm)) !== paths.fileHash)
			throw new Error('upload checksum mismatch');
		await assertLease();
		await fs.promises.rename(tempPath, filePath);
	} catch {
		await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
		return failure(CommonStatus.SERVER_ERR);
	} finally {
		if (lockAcquired) await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
	}

	try {
		await assertLease();
		await registerFile(actor.id, paths);
	} catch (err) {
		console.error('[file] metadata write failed:', err);
		return failure(CommonStatus.SERVER_ERR);
	}
	await assertLease();
	await removeDir(dirPath);
	await releaseUploadQuota(String(actor.id), `${paths.fileHash}:${paths.ext}`);
	await better_chat
		.del(uploadSessionKey(actor.id, paths.fileHash, paths.ext))
		.catch(err => console.error('[file] session cleanup:', err));
	return success({ message: '文件合并成功', filePath: fileDBPath });
};

export const mergeFile = async (actor: Actor, parameters: MergeFileInput): Promise<Outcome> => {
	const paths = getUploadPaths(actor.id, parameters?.fileHash, parameters?.extname);
	if (!paths) return failure(CommonStatus.PARAM_ERR);
	try {
		return await withUploadLease(uploadSessionKey(actor.id, paths.fileHash, paths.ext), assertLease => mergeFileUnlocked(actor, parameters, assertLease));
	} catch { return failure(CommonStatus.SERVER_ERR); }
};

/**
 * 删除目录及其内容
 */
const removeDir = async (dirPath: string): Promise<void> => {
	try {
		const files = await fs.promises.readdir(dirPath);
		await Promise.all(files.map(file => fs.promises.unlink(join(dirPath, file))));
		await fs.promises.rmdir(dirPath);
	} catch (error) {
		// eslint-disable-next-line no-console
		console.error('removeDir error:', error);
	}
};
