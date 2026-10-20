import Redis from 'ioredis';
import { boundedInteger } from '../shared/validation';
const redisUrl = process.env.REDIS_URL;
const redisPort = boundedInteger('REDIS_PORT', 6379, 1, 65535);
const redisKeyPrefix = process.env.REDIS_KEY_PREFIX || '';

// Redis 用于校验 token 白名单（登录时写入，登出/失效时删除）
export const better_chat = redisUrl
	? new Redis(redisUrl, { keyPrefix: redisKeyPrefix, lazyConnect: true, commandTimeout: 5000, maxRetriesPerRequest: 1 })
	: new Redis({
			host: process.env.REDIS_HOST || '127.0.0.1',
			port: redisPort,
			password: process.env.REDIS_PASSWORD || undefined,
			db: boundedInteger('REDIS_DB', 0, 0, 15),
			commandTimeout: 5000,
			maxRetriesPerRequest: 1,
			keyPrefix: redisKeyPrefix,
			lazyConnect: true
		});

better_chat.on('error', err => {
	// eslint-disable-next-line no-console
	console.error('[redis] 连接异常:', err.message);
});
