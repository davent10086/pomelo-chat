import * as fs from 'fs';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import type { Request, Response } from 'express';

import { CommonStatus, FileStatus } from '../../utils/status';
import { RespData, RespSuccess, RespError } from '../../utils/resp';
import { isAllowedUploadMime, normalizeUploadMetadata } from '../../utils/file';
import { Query } from '../../utils/query';
import { better_chat } from '../../utils/authenticate';

const UPLOAD_SESSION_TTL_SECONDS = 60 * 60;
const MAX_CHUNK_COUNT = Number(process.env.MAX_UPLOAD_CHUNKS || 100);
const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE_BYTES || 100 * 1024 * 1024);

interface UploadSession { totalCount: number; uploadToken: string; }

const uploadSessionKey = (userId: number | string, fileHash: string, ext: string) =>
	`upload:session:${userId}:${fileHash}:${ext}`;

const getUploadPaths = (userId: number | string, fileHash: unknown, extname: unknown) => {
	const metadata = normalizeUploadMetadata(fileHash, extname);
	if (!metadata) return null;
	const dirPath = join(process.cwd(), 'uploads', String(userId), metadata.suffix, metadata.fileHash);
	return {
		...metadata,
		dirPath,
		filePath: `${dirPath}.${metadata.ext}`,
		fileDBPath: `/uploads/${userId}/${metadata.suffix}/${metadata.fileHash}.${metadata.ext}`
	};
};

const readSession = async (userId: number | string, paths: NonNullable<ReturnType<typeof getUploadPaths>>, token: unknown): Promise<UploadSession | null> => {
	if (typeof token !== 'string') return null;
	const raw = await better_chat.get(uploadSessionKey(userId, paths.fileHash, paths.ext));
	if (!raw) return null;
	const session = JSON.parse(raw) as Partial<UploadSession>;
	return Number.isInteger(session.totalCount) && session.totalCount! > 0 && typeof session.uploadToken === 'string' && session.uploadToken === token
		? session as UploadSession
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
export const verifyFile = async (req: Request, res: Response): Promise<void> => {
	const { fileHash, totalCount, extname } = req.body || {};
	if (!fileHash || !totalCount || !extname) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	const paths = getUploadPaths(req.user!.id, fileHash, extname);
	const count = Number(totalCount);
	if (!paths || !Number.isInteger(count) || count < 1 || count > MAX_CHUNK_COUNT) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	const { dirPath, filePath, fileDBPath } = paths;
	const metadata = await Query<Array<{ storage_path: string }>>('SELECT storage_path FROM file_metadata WHERE owner_id = ? AND file_hash = ? AND ext = ? AND status = \'ready\' LIMIT 1', [req.user!.id, paths.fileHash, paths.ext]);
	if (metadata.length) return RespData(res, { neededFileList: [], message: '该文件已被上传', filePath: metadata[0].storage_path }, FileStatus.FILE_EXIST);
	const uploadToken = randomUUID();
	await better_chat.set(uploadSessionKey(req.user!.id, paths.fileHash, paths.ext), JSON.stringify({ totalCount: count, uploadToken }), 'EX', UPLOAD_SESSION_TTL_SECONDS);
	let resArr: number[] = Array(count)
		.fill(0)
		.map((_, index) => index + 1);

	try {
		// 读取文件状态
		await fs.statSync(filePath);
		// 读取成功，即秒传
		const data = { neededFileList: [], message: '该文件已被上传', filePath: fileDBPath };
		RespData(res, data, FileStatus.FILE_EXIST);
	} catch (fileError) {
		try {
			await fs.statSync(dirPath);
			const files = await fs.promises.readdir(dirPath);
			if (files.length < totalCount) {
				// 计算待上传序列
				resArr = resArr.filter(fileIndex => {
					return !files.includes(`chunk-${fileIndex}`);
				});
		const data = { neededFileList: resArr, uploadToken };
				RespData(res, data);
			} else {
				// 已上传所有分块但未进行合并, 通知前端合并文件
				const data = {
					neededFileList: [],
					message: '已完成所有分片上传，请合并文件',
					filePath: fileDBPath,
					uploadToken
				};
				RespData(res, data, FileStatus.ALL_CHUNK_UPLOAD);
			}
		} catch (dirError) {
			// 读取文件夹失败，返回全序列
		const data = { neededFileList: resArr, uploadToken };
			RespData(res, data);
		}
	}
};

/**
 * 上传文件块
 */
export const uploadChunk = async (req: Request, res: Response): Promise<void> => {
	const chunk = req.file!.buffer;
	const chunkIndex = parseInt(req.body.chunkIndex, 10);
	const fileHash = req.body.fileHash;
	const extname = req.body.extname;

	const paths = getUploadPaths(req.user!.id, fileHash, extname);
	if (!paths || !Number.isInteger(chunkIndex) || chunkIndex < 1 || !chunk || !isAllowedUploadMime(req.file?.mimetype)) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	const session = await readSession(req.user!.id, paths, req.body.uploadToken).catch(() => null);
	if (!session || chunkIndex > session.totalCount) return RespError(res, CommonStatus.PARAM_ERR);
	const { dirPath } = paths;
	const chunkPath = join(dirPath, `chunk-${chunkIndex}`);

	try {
		const hasDir = await fs.promises
			.access(dirPath)
			.then(() => true)
			.catch(() => false);

		if (!hasDir) {
			await fs.promises.mkdir(dirPath, { recursive: true });
		}

		await fs.promises.writeFile(chunkPath, chunk);

		RespSuccess(res);
	} catch {
		RespError(res, CommonStatus.SERVER_ERR);
		return;
	}
};

/**
 * 合并文件
 */
export const mergeFile = async (req: Request, res: Response): Promise<void> => {
	const { fileHash, extname } = req.body || {};
	if (!fileHash || !extname) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	const paths = getUploadPaths(req.user!.id, fileHash, extname);
	if (!paths) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	const session = await readSession(req.user!.id, paths, req.body.uploadToken).catch(() => null);
	if (!session) return RespError(res, CommonStatus.PARAM_ERR);
	const { dirPath, filePath, fileDBPath } = paths;

	try {
		// 检查文件是否已存在
		await fs.promises.access(filePath);
		const data = { message: '文件已存在', filePath: fileDBPath };
		RespData(res, data);
		return;
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
		if (files.length !== session.totalCount || !Array.from({ length: session.totalCount }, (_, index) => files.includes(`chunk-${index + 1}`)).every(Boolean)) throw new Error('incomplete upload chunks');
		for (let index = 1; index <= session.totalCount; index++) {
			await pipeline(fs.createReadStream(join(dirPath, `chunk-${index}`)), fs.createWriteStream(tempPath, { flags: index === 1 ? 'w' : 'a' }));
		}
		const stat = await fs.promises.stat(tempPath);
		if (stat.size <= 0 || stat.size > MAX_UPLOAD_SIZE) throw new Error('invalid upload size');
		const algorithm = paths.fileHash.length === 64 ? 'sha256' : 'md5';
		if (await hashFile(tempPath, algorithm) !== paths.fileHash) throw new Error('upload checksum mismatch');
		await fs.promises.rename(tempPath, filePath);
	} catch {
		await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
		RespError(res, CommonStatus.SERVER_ERR);
		return;
	} finally {
		if (lockAcquired) await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
	}

	// 删除保存分块的文件夹
	try {
		await removeDir(dirPath);
	} catch {
		/* empty */
	}

	try {
		const stat = await fs.promises.stat(filePath);
		await Query(
			`INSERT INTO file_metadata (owner_id, file_hash, ext, media_type, storage_path, size, mime, status)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'ready')
			 ON DUPLICATE KEY UPDATE storage_path = VALUES(storage_path), size = VALUES(size), status = 'ready', updated_at = CURRENT_TIMESTAMP`,
			[req.user!.id, paths.fileHash, paths.ext, paths.suffix, fileDBPath, stat.size, null]
		);
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[file] metadata write failed:', err.message);
	}

	await better_chat.del(uploadSessionKey(req.user!.id, paths.fileHash, paths.ext));
	const data = { message: '文件合并成功', filePath: fileDBPath };
	RespData(res, data);
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
