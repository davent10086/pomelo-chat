/**
 * 用于启动 node 服务并处理相关路由
 */
import express, { type RequestHandler } from 'express';
import bodyParser from 'body-parser';
import multer from 'multer';
import { randomUUID } from 'crypto';

import authRouter from './routes/auth';
import friendRouter from './routes/friend';
import messageRouter from './routes/message';
import groupRouter from './routes/group';
import rtcRouter from './routes/rtc';
import fileRouter from './routes/file';
import assistantRouter from './routes/assistant';
import { authenticateUploadAccess } from '../composition';
import { createRateLimiter } from '../infrastructure/rate-limit';
import { uploadRoot } from '../infrastructure/file-storage';
import { messageMetricsHandler } from '../infrastructure/message-metrics';
import { validateHttpInput } from '../infrastructure/http-validation';
import { boundedInteger } from '../shared/validation';
import { Query } from '../infrastructure/database-query';
import { better_chat } from '../infrastructure/redis';

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY.split(',').map(value => value.trim()));
let routesRegistered = false;

// CORS 白名单域名（生产环境应通过环境变量配置）
const ALLOWED_ORIGINS = (
	process.env.CORS_ORIGINS ||
	'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000,pomelo://app'
)
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
	res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
	res.header('Access-Control-Allow-Methods', 'PUT,POST,PATCH,GET,DELETE,OPTIONS');
	res.header('Content-Type', 'application/json;charset=utf-8');

	if (req.method.toLowerCase() === 'options') {
		res.sendStatus(200);
	} else {
		next();
	}
};

const requestContext: RequestHandler = (req, res, next) => {
	const requestId =
		typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : randomUUID();
	res.setHeader('X-Request-Id', requestId);
	const startedAt = Date.now();
	res.on('finish', () => {
		if (process.env.REQUEST_LOGS === 'false') return;
		console.log(
			JSON.stringify({
				requestId,
				method: req.method,
				path: req.path,
				status: res.statusCode,
				durationMs: Date.now() - startedAt
			})
		);
	});
	next();
};

const securityHeaders: RequestHandler = (_req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('X-Frame-Options', 'DENY');
	res.setHeader('Referrer-Policy', 'no-referrer');
	res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
	res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
	next();
};

const apiRateLimit = createRateLimiter({
	name: 'api',
	windowSeconds: boundedInteger('API_RATE_LIMIT_WINDOW_SECONDS', 60),
	max: boundedInteger('API_RATE_LIMIT_MAX', 240),
	skip: req => req.path === '/assistant/agent/stream'
});

/**
 * 静态文件访问的中间件，利用 Express 托管静态文件
 * L3: 移除强制 octet-stream，让 express.static 根据扩展名自动设置 content-type
 */
const staticDownload: RequestHandler = (req, res, next) => {
	// Authenticated media may also be embedded by the packaged desktop origin.
	res.header('Cross-Origin-Resource-Policy', 'cross-origin');
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

	app.use(securityHeaders);
	app.get('/internal/metrics', messageMetricsHandler);
	app.use('/uploads', staticDownload, authenticateUploadAccess, express.static(uploadRoot));

	/**
	 * 处理 HTTP 请求体中的参数
	 */
	app.use(requestContext);

	app.use('', cors);
	app.use('/api/chat/v1', cors, apiRateLimit);
	app.use(bodyParser.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));
	app.use(bodyParser.urlencoded({ limit: process.env.FORM_BODY_LIMIT || '2mb', extended: true }));
	app.use('/api/chat/v1', validateHttpInput);
	// Desktop server discovery; this identifies the HTTP service, not dependency readiness.
	app.get('/api/chat/v1/health', (_req, res) => {
		res.setHeader('Cache-Control', 'no-store');
		res.json({ service: 'pomelo-chat', status: 'ok' });
	});
	app.get('/api/chat/v1/ready', async (_req, res) => {
		try {
			await Promise.all([Query('SELECT 1'), better_chat.ping()]);
			res.setHeader('Cache-Control', 'no-store');
			res.json({ service: 'pomelo-chat', status: 'ready' });
		} catch {
			res.status(503).json({ code: 1008, data: '', message: '依赖服务暂不可用' });
		}
	});
	app.use('/api/chat/v1/auth', cors, authRouter());
	app.use('/api/chat/v1/friend', cors, friendRouter());
	app.use('/api/chat/v1/message', cors, messageRouter());
	app.use('/api/chat/v1/group', cors, groupRouter());
	app.use('/api/chat/v1/rtc', cors, rtcRouter());
	app.use('/api/chat/v1/file', cors, fileRouter());
	app.use('/api/chat/v1/assistant', cors, assistantRouter());
	app.use('/api/chat/v1', (_req, res) => {
		res.status(404).json({ code: 1007, data: '', message: '资源不存在' });
	});
	app.use(
		(error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
			const status = error instanceof multer.MulterError ? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400) :
				typeof (error as { status?: unknown })?.status === 'number' &&
				(error as { status: number }).status >= 400 &&
				(error as { status: number }).status < 500
					? (error as { status: number }).status
					: 500;
			if (status >= 500) console.error('[http] unhandled request error:', error);
			res.status(status).json({
				code: status === 413 ? 6003 : status < 500 ? 1003 : 1001,
				data: '',
				message: status === 413 ? '文件大小超出限制' : status < 500 ? '参数错误' : '服务有误'
			});
		}
	);
};

export default app;
