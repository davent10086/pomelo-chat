import * as crypto from 'crypto';
import type { Request } from 'express';
import type { WebSocket } from 'ws';
import { better_chat } from '../../infrastructure/redis';
import { verifyTokenWithSession } from '../identity/public';
import { updateContactPresence } from '../social/public';
import { notifyPresenceContacts } from './presence';
import {
	registerNotificationSocket,
	removeNotificationSocket
} from './connections';
import { registerSessionSocket, validateSessionSocket } from './session-sockets';
export const initUserNotification = async (ws: WebSocket, req: Request): Promise<void> => {
	try {
		const url = req.url!.split('?')[1];
		const params = new URLSearchParams(url);
		const curUsername = params.get('username') || '';
		const token = params.get('token') || '';
		// 校验 token
		const decoded = await verifyTokenWithSession(token);
		if (!decoded || decoded.username !== curUsername) {
			ws.send(JSON.stringify({ name: 'error', message: '认证失败' }));
			ws.close(4001, 'unauthorized');
			return;
		}
		registerSessionSocket(ws, curUsername, token, verifyTokenWithSession);
		const presenceLease = crypto.randomUUID();
		await better_chat.set(`presence:${curUsername}`, presenceLease, 'EX', 30);
		await better_chat.publish(`${process.env.REDIS_KEY_PREFIX || ''}pomelo:presence:changed`,
			JSON.stringify({ username: curUsername, lease: presenceLease }));
		let present = true;
		const heartbeat = setInterval(() => {
			void validateSessionSocket(ws)
				.then(async valid => {
					if (!valid || !present || ws.readyState !== 1) return;
					const renewed = await better_chat.eval(
						"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], 30) end return 0",
						1, `presence:${curUsername}`, presenceLease);
					if (renewed !== 1) ws.close(4004, 'connection replaced');
				})
				.catch(err => console.error('[auth] presence:', err));
		}, 15000);
		heartbeat.unref();
		const cleanupPresence = async () => {
			present = false;
			clearInterval(heartbeat);
			const removed = await better_chat
				.eval(
					"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
					1,
					`presence:${curUsername}`,
					presenceLease
				)
				.catch(err => console.error('[auth] presence cleanup:', err));
			if (removed === 1) {
				await updateContactPresence(curUsername, 'offline').catch(err =>
					console.error('[auth] offline update:', err)
				);
				await notifyPresenceContacts(curUsername);
				await better_chat.publish(`${process.env.REDIS_KEY_PREFIX || ''}pomelo:presence:changed`,
					JSON.stringify({ username: curUsername, lease: presenceLease }));
			}
		};
		if (ws.readyState !== 1) {
			await cleanupPresence();
			return;
		}
		registerNotificationSocket(curUsername, ws, cleanupPresence, presenceLease);

		ws.on('close', () => {
			removeNotificationSocket(curUsername, ws);
		});

		ws.on('error', (err: Error) => {
			console.error(`[通知管道] 连接出错 username=${curUsername}:`, err.message);
		});
		await updateContactPresence(curUsername, 'online');
		await notifyPresenceContacts(curUsername);
	} catch (err) {
		console.error('[auth] notification channel failed:', err);
		ws.close(4001, 'notification channel unavailable');
	}
};
