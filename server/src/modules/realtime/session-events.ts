import type Redis from 'ioredis';
import { better_chat } from '../../infrastructure/redis';
import { closeRevokedSockets } from './session-sockets';
const redisKeyPrefix = process.env.REDIS_KEY_PREFIX || '';
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
