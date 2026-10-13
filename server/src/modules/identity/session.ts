import jwt, { type JwtPayload } from 'jsonwebtoken';
import { better_chat } from '../../infrastructure/redis';
export const secretKey: string | undefined = process.env.JWT_SECRET;
if (!secretKey) {
	// eslint-disable-next-line no-console
	console.error('[auth] 警告：未配置环境变量 JWT_SECRET，JWT 功能将不可用');
}

export const isAuthenticatedPayload = (
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
