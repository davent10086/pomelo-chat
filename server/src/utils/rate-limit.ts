import type { Request, RequestHandler } from 'express';

import { AssistantStatus } from './status';
import { RespError } from './resp';
import { better_chat } from './authenticate';

interface RateLimitOptions {
	name: string;
	windowSeconds: number;
	max: number;
	key?: (req: Request) => string;
	skip?: (req: Request) => boolean;
}

const localBuckets = new Map<string, number[]>();

const defaultKey = (req: Request): string => {
	const userId = req.user?.id;
	if (userId !== undefined && userId !== null) return `user:${userId}`;
	const forwarded = req.headers['x-forwarded-for'];
	const forwardedIp = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
	return `ip:${forwardedIp || req.socket.remoteAddress || 'unknown'}`;
};

export const createRateLimiter = (options: RateLimitOptions): RequestHandler => {
	const windowMs = options.windowSeconds * 1000;
	return async (req, res, next) => {
		if (req.method === 'OPTIONS' || options.skip?.(req)) {
			next();
			return;
		}
		const identity = options.key?.(req) || defaultKey(req);
		const key = `rate:${options.name}:${identity}`;
		try {
			const count = await better_chat.incr(key);
			if (count === 1) await better_chat.expire(key, options.windowSeconds);
			if (count > options.max) {
				res.setHeader('Retry-After', String(options.windowSeconds));
				RespError(res, AssistantStatus.RATE_LIMIT_ERR);
				return;
			}
			next();
		} catch {
			const now = Date.now();
			const bucket = (localBuckets.get(key) || []).filter(item => now - item < windowMs);
			if (bucket.length >= options.max) {
				res.setHeader('Retry-After', String(options.windowSeconds));
				RespError(res, AssistantStatus.RATE_LIMIT_ERR);
				return;
			}
			bucket.push(now);
			localBuckets.set(key, bucket);
			next();
		}
	};
};
