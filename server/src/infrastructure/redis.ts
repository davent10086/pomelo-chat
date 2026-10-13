import Redis from 'ioredis';
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
