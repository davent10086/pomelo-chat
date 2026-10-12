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
const registerFile = async (userId: number | string, paths: NonNullable<ReturnType<typeof getUploadPaths>>) => {
 const stat = await fs.promises.stat(paths.filePath);
 if (stat.size <= 0 || stat.size > MAX_UPLOAD_SIZE || await hashFile(paths.filePath, paths.fileHash.length === 64 ? 'sha256' : 'md5') !== paths.fileHash) throw new Error('Invalid stored upload');
 await Query(`INSERT INTO file_metadata (owner_id, file_hash, ext, media_type, storage_path, size, mime, status)
 VALUES (?, ?, ?, ?, ?, ?, ?, 'ready') ON DUPLICATE KEY UPDATE storage_path = VALUES(storage_path), size = VALUES(size), status = 'ready', updated_at = CURRENT_TIMESTAMP`,
 [userId,paths.fileHash,paths.ext,paths.suffix,paths.fileDBPath,stat.size,null]);
};

export const verifyFile = async (req: Request, res: Response): Promise<void> => {
 const {fileHash,totalCount,extname} = req.body || {};
 const paths = getUploadPaths(req.user!.id,fileHash,extname);
 const count = Number(totalCount);
 if (!paths || !Number.isInteger(count) || count < 1 || count > MAX_CHUNK_COUNT) return RespError(res,CommonStatus.PARAM_ERR);
 try {
  const exists = await fs.promises.stat(paths.filePath).then(stat => stat.isFile()).catch(() => false);
  if (exists) {
   await registerFile(req.user!.id,paths);
   return RespData(res,{neededFileList: [],filePath: paths.fileDBPath},FileStatus.FILE_EXIST);
  }
  await Query("UPDATE file_metadata SET status = 'uploading' WHERE owner_id = ? AND file_hash = ? AND ext = ?", [req.user!.id,paths.fileHash,paths.ext]);
  const key = uploadSessionKey(req.user!.id,paths.fileHash,paths.ext);
  const candidate = JSON.stringify({totalCount: count,uploadToken: randomUUID()});
  await better_chat.set(key,candidate,'EX',UPLOAD_SESSION_TTL_SECONDS,'NX');
  const session = JSON.parse((await better_chat.get(key)) || candidate) as UploadSession;
  if (session.totalCount !== count) return RespError(res,CommonStatus.PARAM_ERR);
  await better_chat.expire(key,UPLOAD_SESSION_TTL_SECONDS);
  const files = await fs.promises.readdir(paths.dirPath).catch(() => [] as string[]);
  const neededFileList = Array.from({length: count},(_,i) => i+1).filter(i => !files.includes('chunk-'+i));
  RespData(res,{neededFileList,uploadToken: session.uploadToken}, neededFileList.length ? undefined : FileStatus.ALL_CHUNK_UPLOAD);
 } catch (err) { console.error('[file] verify failed:',err); RespError(res,CommonStatus.SERVER_ERR); }
};

/**
 * 上传文件块
 */
export const uploadChunk = async (req: Request, res: Response): Promise<void> => {
	const chunk = req.file?.buffer;
	const chunkIndex = Number(req.body?.chunkIndex);
	const fileHash = req.body?.fileHash;
	const extname = req.body?.extname;

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
		await registerFile(req.user!.id, paths);
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

 try {
  await registerFile(req.user!.id,paths);
 } catch (err) { console.error('[file] metadata write failed:',err); return RespError(res,CommonStatus.SERVER_ERR); }
 await removeDir(dirPath);
 await better_chat.del(uploadSessionKey(req.user!.id,paths.fileHash,paths.ext)).catch(err => console.error('[file] session cleanup:',err));
 RespData(res,{message: '文件合并成功',filePath: fileDBPath});
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
