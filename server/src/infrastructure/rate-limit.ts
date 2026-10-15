import type { Request, RequestHandler } from 'express';

import { AssistantStatus } from '../shared/status';
import { RespError } from './http-response';
import { consumeRateLimit } from './rate-counter';

interface RateLimitOptions {
	name: string;
	windowSeconds: number;
	max: number;
	key?: (req: Request) => string;
	skip?: (req: Request) => boolean;
}

const defaultKey = (req: Request): string => {
	const userId = req.user?.id;
	if (userId !== undefined && userId !== null) return `user:${userId}`;
	const forwarded = req.headers['x-forwarded-for'];
	const forwardedIp = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
	return `ip:${forwardedIp || req.socket.remoteAddress || 'unknown'}`;
};

export const createRateLimiter = (options: RateLimitOptions): RequestHandler => {
	return async (req, res, next) => {
		if (req.method === 'OPTIONS' || options.skip?.(req)) {
			next();
			return;
		}
		const identity = options.key?.(req) || defaultKey(req);
		const key = `rate:${options.name}:${identity}`;
		if (!(await consumeRateLimit(key, options.max, options.windowSeconds, 'local'))) {
			res.setHeader('Retry-After', String(options.windowSeconds));
			RespError(res, AssistantStatus.RATE_LIMIT_ERR);
			return;
		}
		next();
	};
};
