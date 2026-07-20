import { Router } from 'express';
import multer from 'multer';
import * as file from '../../service/file';
import { authenticateToken } from '../../utils/authenticate';

const router = Router();

/**
 * 配置文件上传相关路由
 * @returns 配置好的router对象
 */
export default () => {
	// 验证文件路由：验证文件是否存在或完整性
	router.post('/verify_file', authenticateToken, file.verifyFile);

	// 上传文件分片路由：处理文件分片上传，限制单个分片大小为10MB
	router.post(
		'/upload_chunk',
		authenticateToken,
		multer({
			limits: { fileSize: 10 * 1024 * 1024 }
		}).single('chunk'),
		file.uploadChunk
	);

	// 合并文件分片路由：将上传的文件分片合并成完整文件
	router.post('/merge_chunk', authenticateToken, file.mergeFile);

	return router;
};
