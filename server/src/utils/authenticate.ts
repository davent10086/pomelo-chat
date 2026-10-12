import type { RequestHandler, Response, NextFunction } from 'express';
import type { Request } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import Redis from 'ioredis';

import { CommonStatus } from './status';
import { RespError } from './resp';
import { Query } from './query';
import { closeRevokedSockets } from './socket-session';

// 密钥从环境变量读取，未配置时给出明确错误（不内置默认值以防误用）
export const secretKey: string | undefined = process.env.JWT_SECRET;
if (!secretKey) {
	// eslint-disable-next-line no-console
	console.error('[auth] 警告：未配置环境变量 JWT_SECRET，JWT 功能将不可用');
}

const redisUrl = process.env.REDIS_URL;
const redisPort = Number(process.env.REDIS_PORT || 6379);
const redisKeyPrefix = process.env.REDIS_KEY_PREFIX || '';

// Redis 用于校验 token 白名单（登录时写入，登出/失效时删除）
export const better_chat = redisUrl
	? new Redis(redisUrl, { keyPrefix: redisKeyPrefix, lazyConnect: true })
	: new Redis({
			host: process.env.REDIS_HOST || '127.0.0.1',
			port: Number.isFinite(redisPort) ? redisPort : 6379,
			password: process.env.REDIS_PASSWORD || undefined,
			db: Number(process.env.REDIS_DB || 0),
			keyPrefix: redisKeyPrefix,
			lazyConnect: true
		});

better_chat.on('error', err => {
	// eslint-disable-next-line no-console
	console.error('[redis] 连接异常:', err.message);
});

const SESSION_CHANNEL = `${redisKeyPrefix}pomelo:session:changed`;
let sessionSubscriber: Redis | undefined;
const onRedisEnd = () => sessionSubscriber?.disconnect();
export const startSessionSubscription = async () => {
	if (sessionSubscriber) return;
	const subscriber = better_chat.duplicate();
	sessionSubscriber = subscriber;
	better_chat.on('end', onRedisEnd);
	subscriber.on('error', err => console.error('[auth] session subscriber:', err.message));
	subscriber.on('message', async (_channel, raw) => {
		try {
			if (sessionSubscriber !== subscriber) return;
			const event = JSON.parse(raw) as { username: string };
			if (typeof event.username === 'string') {
				const current = await better_chat.get(`token:${event.username}`);
				if (sessionSubscriber !== subscriber) return;
				closeRevokedSockets(event.username, current || undefined);
			}
		} catch {
			console.error('[auth] invalid session event');
		}
	});
	try {
		await subscriber.subscribe(SESSION_CHANNEL);
	} catch (error) {
		stopSessionSubscription();
		throw error;
	}
};
export const stopSessionSubscription = () => {
	better_chat.off('end', onRedisEnd);
	sessionSubscriber?.disconnect();
	sessionSubscriber = undefined;
};

export const notifySessionChanged = async (username: string, token?: string): Promise<void> => {
	const current = await better_chat.get(`token:${username}`);
	if (current === (token || null)) closeRevokedSockets(username, token);
	// Delivery failures cannot restore revoked credentials; per-frame checks also fail closed.
	await better_chat
		.publish(SESSION_CHANNEL, JSON.stringify({ username }))
		.catch(err => console.error('[auth] session publish:', err.message));
};

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const isAuthenticatedPayload = (
	value: JwtPayload
): value is JwtPayload & { id: number | string; username: string } =>
	(typeof value.id === 'number' || typeof value.id === 'string') &&
	typeof value.username === 'string';

// 校验 Bearer token 格式并提取纯 token
export const extractToken = (authHeader?: string): string | null => {
	if (!authHeader) return null;
	// 兼容 "Bearer xxx" 与裸 token 两种格式
	if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
	return authHeader;
};

// JWT 校验中间件：校验签名 + 过期 + Redis 白名单
export const authenticateToken: RequestHandler = (
	req: Request,
	res: Response,
	next: NextFunction
) => {
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
			console.error('[auth] Redis 校验失败，拒绝访问:', redisErr.message);
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
export const authenticateUploadAccess: RequestHandler = async (
	req: Request,
	res: Response,
	next: NextFunction
) => {
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
	const storagePath = `/uploads${req.path}`;
	try {
		const rows = await Query<Array<{ ok: number }>>(
			`SELECT 1 AS ok FROM file_metadata f
			 WHERE f.storage_path = ? AND f.status = 'ready' AND (
				f.owner_id = ? OR EXISTS (
					SELECT 1 FROM message_attachment ma JOIN message m ON m.id = ma.message_id
					WHERE ma.file_id = f.id AND (
					 (m.type = 'private' AND EXISTS (SELECT 1 FROM friend fr JOIN friend_group fg ON fg.id = fr.group_id WHERE fr.room = m.room AND fg.user_id = ?))
					 OR (m.type = 'group' AND EXISTS (SELECT 1 FROM group_chat gc JOIN group_members gm ON gm.group_id = gc.id WHERE gc.room = m.room AND gm.user_id = ?))
					)
				)
				OR (f.media_type = 'image' AND EXISTS (SELECT 1 FROM user u WHERE u.id = f.owner_id AND u.avatar = f.storage_path))
				OR (f.media_type = 'image' AND EXISTS (SELECT 1 FROM group_chat gc WHERE gc.creator_id = f.owner_id AND gc.avatar = f.storage_path))
			 ) LIMIT 1`,
			[storagePath, payload.id, payload.id, payload.id]
		);
		if (!rows.length) {
			res.status(404).end();
			return;
		}
	} catch (error: unknown) {
		console.error('[upload] authorization lookup failed:', errorMessage(error));
		res.status(503).end();
		return;
	}
	req.user = payload;
	next();
};
