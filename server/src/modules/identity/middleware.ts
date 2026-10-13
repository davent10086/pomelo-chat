import type { RequestHandler, Request, Response, NextFunction } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { better_chat } from '../../infrastructure/redis';
import { secretKey, extractToken, isAuthenticatedPayload } from './session';
import { CommonStatus } from '../../shared/status';
import { RespError } from '../../infrastructure/http-response';
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
