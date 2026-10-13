import * as crypto from 'crypto';
import type { Request } from 'express';
import type { WebSocket } from 'ws';
import { better_chat } from '../../infrastructure/redis';
import { verifyTokenWithSession } from '../identity/public';
import { updateContactPresence } from '../social/public';
import { NotificationUser } from './notification';
import {
	notificationUsers,
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
		let present = true;
		const heartbeat = setInterval(() => {
			void validateSessionSocket(ws)
				.then(valid =>
					valid && present && ws.readyState === 1
						? better_chat.set(`presence:${curUsername}`, presenceLease, 'EX', 30)
						: undefined
				)
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
			if (removed === 1)
				await updateContactPresence(curUsername, 'offline').catch(err =>
					console.error('[auth] offline update:', err)
				);
		};
		if (ws.readyState !== 1) {
			await cleanupPresence();
			return;
		}
		registerNotificationSocket(curUsername, ws, cleanupPresence);
		for (const username of notificationUsers()) {
			if (username === curUsername) continue;
			void NotificationUser({ receiver_username: username, name: 'friendList' }).catch(err =>
				console.error('[auth] notification:', err)
			);
		}

		ws.on('close', () => {
			if (removeNotificationSocket(curUsername, ws)) {
				for (const username of notificationUsers()) {
					void NotificationUser({ receiver_username: username, name: 'friendList' }).catch(err =>
						console.error('[auth] notification:', err)
					);
				}
			}
		});

		ws.on('error', (err: Error) => {
			console.error(`[通知管道] 连接出错 username=${curUsername}:`, err.message);
		});
		await updateContactPresence(curUsername, 'online');
	} catch (err) {
		console.error('[auth] notification channel failed:', err);
		ws.close(4001, 'notification channel unavailable');
	}
};
