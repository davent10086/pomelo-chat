import { HttpStatus } from '@/utils/constant';
import { mergeFile, uploadChunk, vertifyFile } from '@/utils/file-api';

// 文件上传方法返回参数
interface IUploadFileRes {
	success: boolean;
	filePath?: string;
	message: string | '';
}

// 文件分片上传接口请求参数
interface IUploadChunkParams {
	chunk: ArrayBuffer;
	chunkIndex: number;
	fileHash: string;
	extname: string;
}

// M9: 最大并发数
const MAX_CONCURRENCY = 4;

/**
 * M9: 并发池，限制同时进行的分片上传数量
 */
async function runWithConcurrency<T>(
	tasks: (() => Promise<T>)[],
	concurrency: number
): Promise<T[]> {
	const results: T[] = [];
	let index = 0;
	const workers: Promise<void>[] = [];
	const runNext = async (): Promise<void> => {
		while (index < tasks.length) {
			const currentIndex = index++;
			try {
				results[currentIndex] = await tasks[currentIndex]();
			} catch (err) {
				// 抛出让外层捕获
				throw err;
			}
		}
	};
	for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
		workers.push(runNext());
	}
	await Promise.all(workers);
	return results;
}

/**
 * 分片上传：
 * M9: Worker 完成后 terminate；分片并发限制；扩展名正确处理
 */
export async function uploadFile(
	file: File,
	baseChunkSize: number,
	maxRetries?: number,
	retryDelay?: number,
	progress_cb?: (progress: number) => void
): Promise<IUploadFileRes> {
	return new Promise((resolve, reject) => {
		const chunkList: ArrayBuffer[] = [];
		let fileHash = '';
		// 创建文件分片Worker
		const sliceFileWorker = new Worker(new URL('./slice-md5-worker.ts', import.meta.url), {
			type: 'module'
		});
		// M9: 标记是否已 resolve/reject，避免 Worker 在 Promise 结束后仍触发
		let settled = false;
		const finalize = (fn: () => void) => {
			if (settled) return;
			settled = true;
			// M9: 无论成功失败，terminate Worker 释放线程
			sliceFileWorker.terminate();
			fn();
		};
		sliceFileWorker.postMessage({ targetFile: file, baseChunkSize });
		sliceFileWorker.onmessage = async e => {
			switch (e.data.messageType) {
				case 'success':
					chunkList.push(...e.data.chunks);
					fileHash = e.data.fileHash;
					try {
						const result = await handleFile(
							file,
							chunkList,
							fileHash,
							maxRetries,
							retryDelay,
							progress_cb
						);
						finalize(() => {
							if (result.success) resolve(result);
							else reject({ success: false, message: result.message });
						});
					} catch (error: unknown) {
						const err = error as { message?: string };
						finalize(() => reject({ success: false, message: err.message || '上传失败' }));
					}
					break;
				case 'progress':
					chunkList.push(...e.data.chunks);
					break;
				case 'fail':
					finalize(() => reject({ success: false, message: '文件分片处理出错' }));
					break;
				default:
					break;
			}
		};
		// M9: Worker 异常时也 terminate
		sliceFileWorker.onerror = () => {
			finalize(() => reject({ success: false, message: '文件分片处理出错' }));
		};
	});
}

// M9: 正确提取扩展名（处理多扩展名与无扩展名）
const getExtname = (filename: string): string => {
	const lastDot = filename.lastIndexOf('.');
	if (lastDot <= 0) return ''; // 无扩展名或隐藏文件
	return filename.slice(lastDot + 1).toLowerCase();
};

async function handleFile(
	file: File,
	chunkList: ArrayBuffer[],
	fileHash: string,
	maxRetries?: number,
	retryDelay?: number,
	progress_cb?: (progress: number) => void
): Promise<IUploadFileRes> {
	const filename = file.name;
	// M9: 用 lastIndexOf 取最后一个扩展名，处理 .tar.gz 等
	const extname = getExtname(filename);
	const allChunkList = chunkList;
	let neededChunkList: number[] = [];
	let progress = 0;
	try {
		const params = { fileHash, totalCount: allChunkList.length, extname };
		const res = await vertifyFile(params);

		if (res.code === HttpStatus.FILE_EXIST) {
			return { success: true, filePath: res.data.filePath, message: res.data.message || '' };
		} else if (res.code === HttpStatus.ALL_CHUNK_UPLOAD) {
			const mergeParams = { fileHash, extname };
			try {
				const mergeRes = await mergeFile(mergeParams);
				if (mergeRes.code === HttpStatus.SUCCESS) {
					return { success: true, filePath: mergeRes.data.filePath, message: mergeRes.data.message || '' };
				}
				throw new Error('文件合并失败');
			} catch {
				throw new Error('文件合并失败');
			}
		} else if (res.code === HttpStatus.SUCCESS) {
			const { neededFileList, message } = res.data;
			if (!neededFileList.length) {
				return { success: true, filePath: res.data.filePath, message: message || '' };
			}
			neededChunkList = neededFileList;
		} else {
			throw new Error('获取文件上传状态失败');
		}
	} catch (error: unknown) {
		const err = error as { message?: string };
		throw new Error(err.message || '获取文件上传状态失败');
	}

	progress = ((allChunkList.length - neededChunkList.length) / allChunkList.length) * 100;
	if (!allChunkList.length) {
		throw new Error('文件分片失败');
	}

	// M9: 使用并发池限制分片上传并发数
	const tasks: (() => Promise<void>)[] = allChunkList.map((chunk: ArrayBuffer, index: number) => {
		return async () => {
			if (neededChunkList.includes(index + 1)) {
				const params = { chunk, chunkIndex: index + 1, fileHash, extname };
				try {
					await uploadChunkWithRetry(params, maxRetries, retryDelay);
					progress += Math.ceil(100 / allChunkList.length);
					if (progress >= 100) progress = 100;
					if (progress_cb) progress_cb(progress);
				} catch {
					throw new Error('存在上传失败的分片');
				}
			}
		};
	});

	try {
		await runWithConcurrency(tasks, MAX_CONCURRENCY);
		// 发送合并请求
		const params = { fileHash, extname };
		const mergeRes = await mergeFile(params);
		if (mergeRes.code === HttpStatus.SUCCESS) {
			return { success: true, filePath: mergeRes.data.filePath, message: mergeRes.data.message || '' };
		}
		throw new Error('文件合并失败');
	} catch (error: unknown) {
		const err = error as { message?: string };
		throw new Error(err.message || '存在上传失败的分片');
	}
}

// 分片上传重试
const uploadChunkWithRetry = async (
	params: IUploadChunkParams,
	maxRetries = 3,
	retryDelay = 1000
) => {
	let retries = 0;
	while (retries < maxRetries) {
		try {
			const res = await uploadChunk(params);
			if (res.code === HttpStatus.SUCCESS) {
				return res;
			}
			throw new Error('分片上传失败');
		} catch {
			retries++;
			if (retries >= maxRetries) {
				throw new Error('分片上传失败');
			}
			await new Promise(resolve => setTimeout(resolve, retryDelay));
		}
	}
};
