/**
 * 用于启动 node 服务并处理相关路由
 */
import express, { type RequestHandler } from 'express';
import bodyParser from 'body-parser';

import authRouter from './routes/auth';
import friendRouter from './routes/friend';
import messageRouter from './routes/message';
import groupRouter from './routes/group';
import rtcRouter from './routes/rtc';
import fileRouter from './routes/file';
import assistantRouter from './routes/assistant';
import { authenticateUploadAccess } from '../utils/authenticate';

const app = express();
let routesRegistered = false;

// CORS 白名单域名（生产环境应通过环境变量配置）
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
	.split(',')
	.map(s => s.trim())
	.filter(Boolean);

/**
 * 解决跨域：使用具体 Origin 回显，配合 Credentials
 */
const cors: RequestHandler = (req, res, next) => {
	const origin = req.headers.origin;
	if (origin && ALLOWED_ORIGINS.includes(origin)) {
		res.header('Access-Control-Allow-Origin', origin);
		res.header('Access-Control-Allow-Credentials', 'true');
		// Vary 头便于缓存正确处理不同 Origin
		res.header('Vary', 'Origin');
	}
	// 允许的 header 类型（具体列出，避免 *）
	res.header(
		'Access-Control-Allow-Headers',
		'Content-Type, Authorization, X-Requested-With'
	);
	res.header('Access-Control-Allow-Methods', 'PUT,POST,GET,DELETE,OPTIONS');
	res.header('Content-Type', 'application/json;charset=utf-8');

	if (req.method.toLowerCase() === 'options') {
		res.sendStatus(200);
	} else {
		next();
	}
};

/**
 * 静态文件访问的中间件，利用 Express 托管静态文件
 * L3: 移除强制 octet-stream，让 express.static 根据扩展名自动设置 content-type
 */
const staticDownload: RequestHandler = (req, res, next) => {
	res.header('Referrer-Policy', 'no-referrer');
	const origin = req.headers.origin;
	if (origin && ALLOWED_ORIGINS.includes(origin)) {
		res.header('Access-Control-Allow-Origin', origin);
		res.header('Access-Control-Allow-Credentials', 'true');
		res.header('Vary', 'Origin');
	}
	res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
	res.header('Access-Control-Allow-Methods', 'PUT, POST, GET, DELETE, OPTIONS, HEAD');
	if (req.method.toLowerCase() === 'options') {
		res.sendStatus(200);
	} else {
		next();
	}
};
export const registerAppRoutes = (): void => {
	if (routesRegistered) return;
	routesRegistered = true;

	app.use('/uploads', authenticateUploadAccess, staticDownload, express.static('uploads'));

	/**
	 * 处理 HTTP 请求体中的参数
	 */
	app.use(bodyParser.json({ limit: '100mb' }));
	app.use(bodyParser.urlencoded({ limit: '100mb', extended: true }));

	app.use('', cors);
	app.use('/api/chat/v1/auth', cors, authRouter());
	app.use('/api/chat/v1/friend', cors, friendRouter());
	app.use('/api/chat/v1/message', cors, messageRouter());
	app.use('/api/chat/v1/group', cors, groupRouter());
	app.use('/api/chat/v1/rtc', cors, rtcRouter());
	app.use('/api/chat/v1/file', cors, fileRouter());
	app.use('/api/chat/v1/assistant', cors, assistantRouter());
};

export default app;
