import * as fs from 'fs';
import { join } from 'path';
import type { Request, Response } from 'express';

import { CommonStatus, FileStatus } from '../../utils/status';
import { RespData, RespSuccess, RespError } from '../../utils/resp';
import { normalizeUploadMetadata } from '../../utils/file';

const getUploadPaths = (fileHash: unknown, extname: unknown) => {
	const metadata = normalizeUploadMetadata(fileHash, extname);
	if (!metadata) return null;
	const dirPath = join(process.cwd(), 'uploads', metadata.suffix, metadata.fileHash);
	return {
		...metadata,
		dirPath,
		filePath: `${dirPath}.${metadata.ext}`,
		fileDBPath: `/uploads/${metadata.suffix}/${metadata.fileHash}.${metadata.ext}`
	};
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
	const paths = getUploadPaths(fileHash, extname);
	const count = Number(totalCount);
	if (!paths || !Number.isInteger(count) || count < 1 || count > 10000) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	const { dirPath, filePath, fileDBPath } = paths;
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
				const data = { neededFileList: resArr };
				RespData(res, data);
			} else {
				// 已上传所有分块但未进行合并, 通知前端合并文件
				const data = {
					neededFileList: [],
					message: '已完成所有分片上传，请合并文件',
					filePath: fileDBPath
				};
				RespData(res, data, FileStatus.ALL_CHUNK_UPLOAD);
			}
		} catch (dirError) {
			// 读取文件夹失败，返回全序列
			const data = { neededFileList: resArr };
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

	const paths = getUploadPaths(fileHash, extname);
	if (!paths || !Number.isInteger(chunkIndex) || chunkIndex < 1 || !chunk) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
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
	const paths = getUploadPaths(fileHash, extname);
	if (!paths) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
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

	// 创建写入流
	const writeStream = fs.createWriteStream(filePath);

	// 读取文件夹，将文件夹中的所有分块进行合并
	try {
		const files = (await fs.promises.readdir(dirPath)).filter(name => /^chunk-\d+$/.test(name));
		if (!files.length) throw new Error('no upload chunks');

		// 对文件进行排序
		files.sort((a, b) => {
			const indexA = parseInt(a.split('-').pop() as string);
			const indexB = parseInt(b.split('-').pop() as string);
			return indexA - indexB;
		});

		// 按顺序写入/合并
		for (let index = 0; index < files.length; index++) {
			const filename = files[index];
			const curFilePath = join(dirPath, filename);
			const readStream = fs.createReadStream(curFilePath);

			// 判断是否是最后一块
			const isLastChunk = index === files.length - 1;

			// 使用 await 确保异步操作完成
			await new Promise<void>((resolve, reject) => {
				readStream.pipe(writeStream, { end: isLastChunk });
				readStream.on('end', resolve);
				readStream.on('error', reject);
			});
		}
	} catch {
		RespError(res, CommonStatus.SERVER_ERR);
		return;
	}

	// 删除保存分块的文件夹
	try {
		await removeDir(dirPath);
	} catch {
		/* empty */
	}

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
