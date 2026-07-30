import type { RequestHandler, Response, NextFunction } from 'express';
import type { Request } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import Redis from 'ioredis';

import { CommonStatus } from './status';
import { RespError } from './resp';

// 密钥从环境变量读取，未配置时给出明确错误（不内置默认值以防误用）
export const secretKey: string | undefined = process.env.JWT_SECRET;
if (!secretKey) {
	// eslint-disable-next-line no-console
	console.error('[auth] 警告：未配置环境变量 JWT_SECRET，JWT 功能将不可用');
}

const redisUrl = process.env.REDIS_URL;
const redisPort = Number(process.env.REDIS_PORT || 6379);

// Redis 用于校验 token 白名单（登录时写入，登出/失效时删除）
export const better_chat = redisUrl
	? new Redis(redisUrl)
	: new Redis({
			host: process.env.REDIS_HOST || '127.0.0.1',
			port: Number.isFinite(redisPort) ? redisPort : 6379,
			password: process.env.REDIS_PASSWORD || undefined,
			db: Number(process.env.REDIS_DB || 0)
		});

better_chat.on('error', err => {
	// eslint-disable-next-line no-console
	console.error('[redis] 连接异常:', err.message);
});

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const isAuthenticatedPayload = (value: JwtPayload): value is JwtPayload & { id: number | string; username: string } =>
	(typeof value.id === 'number' || typeof value.id === 'string') && typeof value.username === 'string';

// 校验 Bearer token 格式并提取纯 token
export const extractToken = (authHeader?: string): string | null => {
	if (!authHeader) return null;
	// 兼容 "Bearer xxx" 与裸 token 两种格式
	if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
	return authHeader;
};

// JWT 校验中间件：校验签名 + 过期 + Redis 白名单
export const authenticateToken: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
	const raw = req.headers.authorization;
	const token = extractToken(raw);
	if (!token) {
		return RespError(res, CommonStatus.TOKEN_ERR);
	}
	jwt.verify(token, secretKey as jwt.Secret, async (err, decoded) => {
		if (err) {
			return RespError(res, CommonStatus.TOKEN_ERR);
		}
		// 校验 Redis 白名单：token 必须在 Redis 中存在（实现真正的登出失效）
		try {
			const payload = decoded as JwtPayload;
			if (!isAuthenticatedPayload(payload)) {
				return RespError(res, CommonStatus.TOKEN_ERR);
			}
			const cached = await better_chat.get(`token:${payload.username}`);
			if (cached !== token) {
				return RespError(res, CommonStatus.TOKEN_ERR);
			}
			// 挂载到 req.user 供后续处理使用
			req.user = payload;
		} catch (caught: unknown) {
			const redisErr = caught instanceof Error ? caught : new Error(String(caught));
			// Redis 不可用时降级放行（避免 Redis 故障导致全站不可用），并记录日志
			// eslint-disable-next-line no-console
			console.error('[auth] Redis 校验失败，降级放行:', redisErr.message);
			return RespError(res, CommonStatus.TOKEN_ERR);
		}
		next();
	});
};

// 用于 ws 握手时同步校验 token（非中间件场景）
export const verifyToken = (token?: string): JwtPayload | null => {
	const pure = extractToken(token);
	if (!pure) return null;
	try {
		const decoded = jwt.verify(pure, secretKey as jwt.Secret);
		return decoded as JwtPayload;
	} catch {
		return null;
	}
};

/** WebSocket 握手校验：JWT 有效且仍在 Redis 白名单中。 */
export const verifyTokenWithSession = async (token?: string): Promise<JwtPayload | null> => {
	const pure = extractToken(token);
	const decoded = verifyToken(pure ?? undefined);
	if (!pure || !decoded?.username) return null;
	try {
		return (await better_chat.get(`token:${decoded.username}`)) === pure ? decoded : null;
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[auth] WebSocket Redis validation failed:', err.message);
		return null;
	}
};

/** 静态上传资源使用查询参数令牌，供 img/video 等无法添加 Authorization 头的元素调用。 */
export const authenticateUploadAccess: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
	const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
	const token = req.headers.authorization || queryToken;
	const payload = await verifyTokenWithSession(token);
	if (!payload) {
		res.status(401).end();
		return;
	}
	if (!isAuthenticatedPayload(payload)) {
		res.status(401).end();
		return;
	}
	req.user = payload;
	next();
};
