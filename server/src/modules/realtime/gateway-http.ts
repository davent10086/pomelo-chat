import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { verifyTokenWithSession } from '../identity/public';
import { authorizeChatRoom, updateContactPresence } from '../social/public';
import { fetchHistoryMessages, writeAndSend } from '../messaging/public';
import {
	enqueueRoomWrite,
	isChatType,
	isMediaType,
	MAX_MESSAGE_LENGTH,
	type UserId
} from '../messaging/contracts';
import { MessageOverloadError } from '../../shared/overload';
import { better_chat } from '../../infrastructure/redis';
import { notifyPresenceContacts } from './presence';
import { backendReady } from '../../infrastructure/backend-readiness';

/** Private bridge: derive the actor from original credentials, never a supplied ID. */
export const createGatewayRouter = () => {
	const router = Router();
	router.use((req, res, next) => {
		const secret = process.env.REALTIME_INTERNAL_TOKEN;
		const expected = `Bearer ${secret || ''}`;
		const supplied = req.headers.authorization || '';
		if (
			!secret ||
			Buffer.byteLength(expected) !== Buffer.byteLength(supplied) ||
			!timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
		) {
			res.sendStatus(404);
			return;
		}
		next();
	});
	router.post('/:operation', async (req, res) => {
		try {
			const input = req.body || {};
			const token = typeof input.token === 'string' ? input.token : '';
			if (req.params.operation === 'ready') {
				const ready = await backendReady();
				res.status(ready ? 200 : 503).json({ ready });
				return;
			}
			// Cleanup must remain possible after token revocation; only the service can call it.
			if (req.params.operation === 'presence-offline') {
				if (
					typeof input.username !== 'string' ||
					!input.username ||
					(await better_chat.exists(`presence:${input.username}`))
				) {
					res.sendStatus(409);
					return;
				}
				await updateContactPresence(input.username, 'offline');
				await notifyPresenceContacts(input.username);
				res.json({ ok: true });
				return;
			}
			const actor = await verifyTokenWithSession(token);
			if (!actor) {
				res.sendStatus(401);
				return;
			}
			if (req.params.operation === 'presence-online') {
				if (!(await better_chat.exists(`presence:${actor.username}`))) {
					res.sendStatus(409);
					return;
				}
				await updateContactPresence(String(actor.username), 'online');
				await notifyPresenceContacts(String(actor.username));
				res.json({ ok: true });
				return;
			}
			const { room, type } = input;
			if (typeof room !== 'string' || !room || !isChatType(type)) {
				res.sendStatus(400);
				return;
			}
			if (!(await authorizeChatRoom(actor.id as UserId, room, type))) {
				res.sendStatus(403);
				return;
			}
			if (req.params.operation === 'authorize') {
				res.json({ ok: true });
				return;
			}
			if (req.params.operation === 'history') {
				const history = await fetchHistoryMessages(actor.id as UserId, room, type);
				if (!history || !(await verifyTokenWithSession(token))) {
					res.sendStatus(403);
					return;
				}
				res.json({
					name: 'history',
					peerReadSeq: history.peerReadSeq,
					messages: history.messages,
					hasMore: history.hasMore,
					nextBeforeId: history.nextBeforeId
				});
				return;
			}
			if (req.params.operation !== 'send') {
				res.sendStatus(404);
				return;
			}
			if (
				typeof input.content !== 'string' ||
				!input.content.trim() ||
				input.content.length > MAX_MESSAGE_LENGTH
			) {
				res.status(400).json({
					name: 'error',
					client_msg_id: input.clientMsgId,
					message: '消息为空或超过长度限制，已停止重试'
				});
				return;
			}
			const mediaType = isMediaType(input.mediaType) ? input.mediaType : 'text';
			const clientMsgId =
				typeof input.clientMsgId === 'string' &&
				/^[a-zA-Z0-9_-]{8,64}$/.test(input.clientMsgId.trim())
					? input.clientMsgId.trim()
					: null;
			const outbound = await enqueueRoomWrite(room, async () => {
				const access = await authorizeChatRoom(actor.id as UserId, room, type);
				if (!access || !(await verifyTokenWithSession(token)))
					throw new Error('Session or room access revoked');
				const fileSize = Number.isFinite(Number(input.fileSize)) ? Number(input.fileSize) : 0;
				return writeAndSend(
					type,
					room,
					{
						sender_id: actor.id as UserId,
						receiver_id: access.receiverId,
						content: input.content,
						room,
						type,
						media_type: mediaType,
						file_size: fileSize,
						status: 0,
						client_msg_id: clientMsgId
					},
					{
						sender_id: actor.id as UserId,
						receiver_id: access.receiverId,
						content: input.content,
						room,
						type: mediaType,
						file_size: fileSize
					},
					async () => !!(await verifyTokenWithSession(token))
				);
			});
			res.json({
				name: 'ack',
				id: outbound.id,
				client_msg_id: outbound.client_msg_id,
				room_seq: outbound.room_seq
			});
		} catch (error) {
			if (error instanceof MessageOverloadError) {
				res.status(429).json({
					name: 'error',
					code: error.code,
					client_msg_id: req.body?.clientMsgId,
					message: error.message,
					retryable: true,
					retryAfterMs: error.retryAfterMs
				});
				return;
			}
			const reason = error instanceof Error ? error.message : String(error);
			console.error('[gateway:bridge]', reason);
			const message = reason.includes('Idempotency')
				? '消息 ID 与原内容冲突，已停止重试'
				: /file|attachment/i.test(reason)
					? '附件已失效或无权访问，已停止重试'
					: reason.includes('revoked')
						? '会话权限已失效，已停止重试'
						: '消息发送失败，请核对后手动重试';
			res.status(500).json({ name: 'error', client_msg_id: req.body?.clientMsgId, message });
		}
	});
	return router;
};
