import type Redis from 'ioredis';
import { better_chat } from '../../infrastructure/redis';
import { closeRevokedSockets } from './session-sockets';
import { getNotificationSocket, getNotificationLease } from './connections';
import { recheckRoomSockets } from './room-access';
const redisKeyPrefix = process.env.REDIS_KEY_PREFIX || '';
const SESSION_CHANNEL = `${redisKeyPrefix}pomelo:session:changed`;
const PRESENCE_CHANNEL = `${redisKeyPrefix}pomelo:presence:changed`;
const ROOM_CHANNEL = `${redisKeyPrefix}pomelo:room:access`;
let sessionSubscriber: Redis | undefined;
const onRedisEnd = () => sessionSubscriber?.disconnect();
export const startSessionSubscription = async () => {
	if (sessionSubscriber) return;
	const subscriber = better_chat.duplicate();
	sessionSubscriber = subscriber;
	better_chat.on('end', onRedisEnd);
	subscriber.on('error', err => console.error('[auth] session subscriber:', err.message));
	subscriber.on('message', async (channel, raw) => {
		try {
			if (sessionSubscriber !== subscriber) return;
			const event = JSON.parse(raw) as { username: string; room?: string; userId?: string };
			if (channel === ROOM_CHANNEL) {
				if (typeof event.room === 'string') await recheckRoomSockets(event.room, event.userId);
				return;
			}
			if (typeof event.username === 'string') {
				if (channel === PRESENCE_CHANNEL) {
					const current = await better_chat.get(`presence:${event.username}`);
					const socket = getNotificationSocket(event.username);
					if (socket && current && current !== getNotificationLease(event.username)) socket.close(4004, 'connection replaced');
					return;
				}
				const current = await better_chat.get(`token:${event.username}`);
				if (sessionSubscriber !== subscriber) return;
				closeRevokedSockets(event.username, current || undefined);
			}
		} catch {
			console.error('[auth] invalid session event');
		}
	});
	try {
		await subscriber.subscribe(SESSION_CHANNEL, PRESENCE_CHANNEL, ROOM_CHANNEL);
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
