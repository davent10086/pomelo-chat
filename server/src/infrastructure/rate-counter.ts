import { better_chat } from './redis';

const counterScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;
const localBuckets = new Map<string, { timestamps: number[]; expiresAt: number }>();

/** Callers retain their own budgets and Redis failure policies. */
export const consumeRateLimit = async (
	key: string,
	max: number,
	windowSeconds: number,
	fallback: 'local' | 'reject'
): Promise<boolean> => {
	try {
		const count = Number(await better_chat.eval(counterScript, 1, key, windowSeconds));
		if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid rate counter');
		return count <= max;
	} catch (error) {
		if (fallback === 'reject') throw error;
		const now = Date.now();
		const timestamps = (localBuckets.get(key)?.timestamps || []).filter(
			time => now - time < windowSeconds * 1000
		);
		if (timestamps.length >= max) return false;
		if (!localBuckets.has(key) && localBuckets.size >= 10000) {
			for (const [name, bucket] of localBuckets)
				if (bucket.expiresAt <= now) localBuckets.delete(name);
			if (localBuckets.size >= 10000) return false;
		}
		timestamps.push(now);
		localBuckets.set(key, { timestamps, expiresAt: now + windowSeconds * 1000 });
		return true;
	}
};
