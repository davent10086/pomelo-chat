import type { RawData, WebSocket } from 'ws';
import type { Request } from 'express';
import { verifyTokenWithSession } from '../identity/public';
import { registerSessionSocket, validateSessionSocket } from './session-sockets';
import { authorizeChatRoom } from '../social/public';
import { fetchHistoryMessages } from '../messaging/public';
import { writeAndSend } from '../messaging/public';
import { ChatRooms, sendFrame } from './message-delivery';
import { acknowledgeDelivery } from './delivery-observation';
import { MessageOverloadError } from '../../shared/overload';
import {
	isRecord,
	normalizeFileName,
	isMediaType,
	isChatType,
	enqueueRoomWrite,
	MAX_MESSAGE_LENGTH,
	HISTORY_PAGE_SIZE,
	type IncomingMessage,
	type UserId
} from '../messaging/contracts';
const parseIncomingMessage = (
	data: RawData | string
): IncomingMessage | { name: 'delivery_ack'; receipt: string } | null => {
	try {
		const raw =
			typeof data === 'string'
				? data
				: Array.isArray(data)
					? Buffer.concat(data).toString('utf8')
					: Buffer.isBuffer(data)
						? data.toString('utf8')
						: Buffer.from(new Uint8Array(data)).toString('utf8');
		const value: unknown = JSON.parse(raw);
		if (
			isRecord(value) &&
			value.name === 'delivery_ack' &&
			typeof value.receipt === 'string' &&
			/^[a-f0-9]{32}$/.test(value.receipt)
		)
			return { name: 'delivery_ack', receipt: value.receipt };
		if (!isRecord(value) || typeof value.content !== 'string') return null;
		return {
			content: value.content,
			type: value.type,
			fileName: value.fileName,
			fileSize: value.fileSize,
			clientMsgId: value.clientMsgId
		};
	} catch {
		return null;
	}
};

const normalizeClientMsgId = (value: unknown): string | null => {
	if (typeof value !== 'string') return null;
	const text = value.trim();
	return /^[a-zA-Z0-9_-]{8,64}$/.test(text) ? text : null;
};

const getWsToken = (req: Request): string => {
	const protocols = String(req.headers['sec-websocket-protocol'] || '')
		.split(',')
		.map(item => item.trim())
		.filter(Boolean);
	const protocolToken = protocols.find(item => item !== 'pomelo-token');
	return protocolToken || '';
};

export const connectChat = async (ws: WebSocket, req: Request): Promise<void> => {
	const pendingFrames: RawData[] = [];
	const bufferFrame = (data: RawData) => {
		const size = Array.isArray(data)
			? data.reduce((sum, part) => sum + part.length, 0)
			: data instanceof ArrayBuffer
				? data.byteLength
				: Buffer.byteLength(data);
		if (pendingFrames.length >= 8 || size > 65536) {
			ws.close(4002, 'handshake buffer exceeded');
			return;
		}
		pendingFrames.push(data);
	};
	ws.on('message', bufferFrame);
	const params = new URLSearchParams(req.url!.split('?')[1]);
	const room = params.get('room') || '';
	const id = params.get('id') || '';
	const type = params.get('type') || '';
	const token = getWsToken(req);
	const decoded = await verifyTokenWithSession(token);
	if (!decoded || String(decoded.id) !== String(id)) {
		sendFrame(ws, { name: 'error', message: 'unauthorized' });
		ws.close(4001, 'unauthorized');
		return;
	}
	if (!(room && id && isChatType(type))) {
		sendFrame(ws, { name: 'error', message: 'invalid room params' });
		ws.close(4002, 'bad request');
		return;
	}
	try {
		const authorized = await authorizeChatRoom(decoded.id as UserId, room, type);
		if (!authorized) {
			sendFrame(ws, { name: 'error', message: 'forbidden' });
			ws.close(4003, 'forbidden');
			return;
		}
		if (ws.readyState !== 1) return;
		ChatRooms[room] ||= {};
		const socketKey = `${id}:${Math.random().toString(36).slice(2)}`;
		ChatRooms[room][socketKey] = { ws, userId: decoded.id as UserId, type };
		registerSessionSocket(ws, String(decoded.username), token, verifyTokenWithSession);
		// Register message handling before the initial history frame. A client may
		// send immediately after receiving that frame, so registering it afterwards
		// creates a race that silently drops the first message.
		ws.on('message', async (data: RawData) => {
			const parsed = parseIncomingMessage(data);
			if (parsed && 'name' in parsed) {
				acknowledgeDelivery(ws, parsed.receipt);
				return;
			}
			const message = parsed;
			try {
				// Room access is revalidated when this message reaches the room queue below.
				if (!message || !message.content.trim() || message.content.length > MAX_MESSAGE_LENGTH) {
					sendFrame(ws, {
						name: 'error',
						client_msg_id: message?.clientMsgId,
						message: '消息为空或超过长度限制，已停止重试'
					});
					return;
				}
				const mediaType = isMediaType(message.type) ? message.type : 'text';
				const clientMsgId = normalizeClientMsgId(message.clientMsgId);
				if (message.clientMsgId !== undefined && message.clientMsgId !== null && !clientMsgId) {
					sendFrame(ws, { name: 'error', client_msg_id: message.clientMsgId, message: '无效的消息标识，已停止重试' });
					return;
				}
				const fileName = mediaType === 'text' ? null : normalizeFileName(message.fileName);
				const outbound = await enqueueRoomWrite(room, async () => {
					if (
						!(await validateSessionSocket(ws)) ||
						!(await authorizeChatRoom(decoded.id as UserId, room, type))
					)
						throw new Error('Session or room access revoked');
					return writeAndSend(
						type,
						room,
						{
							sender_id: decoded.id as UserId,
							receiver_id: authorized.receiverId,
							content: message.content,
							room,
							type,
							media_type: mediaType,
							file_name: fileName,
							file_size: Number.isFinite(Number(message.fileSize)) ? Number(message.fileSize) : 0,
							status: 0,
							client_msg_id: clientMsgId
						},
						{
							sender_id: decoded.id as UserId,
							receiver_id: authorized.receiverId,
							content: message.content,
							room,
							type: mediaType,
							file_size: Number.isFinite(Number(message.fileSize)) ? Number(message.fileSize) : 0
						},
						() => validateSessionSocket(ws)
					);
				});
				if (!(await validateSessionSocket(ws))) return;
				sendFrame(ws, {
					name: 'ack',
					id: outbound.id,
					client_msg_id: outbound.client_msg_id,
					room_seq: outbound.room_seq
				});
			} catch (err: unknown) {
				if (err instanceof MessageOverloadError) {
					sendFrame(ws, {
						name: 'error',
						code: err.code,
						client_msg_id: message?.clientMsgId,
						message: err.message,
						retryAfterMs: err.retryAfterMs,
						retryable: true
					});
					return;
				}
				const errorText = err instanceof Error ? err.message : String(err);
				console.error('[message] ws message error:', errorText);
				if (ws.readyState === 1)
					sendFrame(ws, {
						name: 'error',
						client_msg_id: message?.clientMsgId,
						message: errorText.includes('Idempotency')
							? '消息 ID 与原内容冲突，已停止重试'
							: errorText.toLowerCase().includes('file') ||
								  errorText.toLowerCase().includes('attachment')
								? '附件已失效或无权访问，已停止重试'
								: errorText.includes('revoked')
									? '会话权限已失效，已停止重试'
									: '消息发送失败，请核对后手动重试'
					});
			}
		});
		ws.removeListener('message', bufferFrame);
		for (const frame of pendingFrames.splice(0)) ws.emit('message', frame);
		ws.on('close', () => {
			if (ChatRooms[room]?.[socketKey]?.ws === ws) {
				delete ChatRooms[room][socketKey];
				if (!Object.keys(ChatRooms[room]).length) delete ChatRooms[room];
			}
		});
		ws.on('error', (err: Error) => {
			console.error(`[message] ws error room=${room} id=${id}:`, err.message);
		});
		const history = await fetchHistoryMessages(
			decoded.id as UserId,
			room,
			type,
			undefined,
			HISTORY_PAGE_SIZE
		);
		if (!(await validateSessionSocket(ws))) return;
		if (!(await authorizeChatRoom(decoded.id as UserId, room, type))) {
			ws.close(4003, 'room access revoked');
			return;
		}
		sendFrame(ws, {
			name: 'history',
			peerReadSeq: history?.peerReadSeq || 0,
			messages: history?.messages || [],
			hasMore: history?.hasMore,
			nextBeforeId: history?.nextBeforeId
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[message] connectChat error:', message);
		sendFrame(ws, { name: 'error', message: 'message channel failed' });
		ws.close();
	} finally {
		ws.removeListener('message', bufferFrame);
	}
};
