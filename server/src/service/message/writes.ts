import { Query, withTransaction } from '../../utils/query';
import { formatBytes } from '../../utils/format';
import { persistMessage } from './persistence';
import { flushMessageOutbox } from './outbox';
import { authorizeChatRoom } from './permissions';
import {
	MAX_MESSAGE_LENGTH,
	type HistoryMessageRow,
	type ChatType,
	type InsertMessage,
	type OutboundMessage
} from './contracts';
export const writeAndSend = async (
	type: ChatType,
	room: string,
	msg: InsertMessage,
	message: OutboundMessage,
	sessionGuard?: () => Promise<boolean>
): Promise<OutboundMessage> => {
	msg.status = 0;
	const saved = await withTransaction(async query => {
		await query('INSERT IGNORE INTO conversation (room, type, target_id) VALUES (?, ?, ?)', [
			room,
			type,
			msg.receiver_id
		]);
		await query('SELECT id FROM conversation WHERE room = ? FOR UPDATE', [room]);
		if (sessionGuard && !(await sessionGuard()))
			throw new Error('Session revoked while waiting for transaction');
		if (msg.client_msg_id) {
			const existing = await query<HistoryMessageRow[]>(
				`SELECT id, client_msg_id, room_seq, sender_id, receiver_id, content, room, media_type, file_size, created_at, NULL AS avatar
				 FROM message WHERE sender_id = ? AND client_msg_id = ? LIMIT 1 FOR UPDATE`,
				[msg.sender_id, msg.client_msg_id]
			);
			if (existing.length) {
				if (
					existing[0].room !== room ||
					existing[0].content !== msg.content ||
					existing[0].media_type !== msg.media_type
				)
					throw new Error('Idempotency key conflict');
				return { row: existing[0], inserted: false };
			}
		}
		const insertId = await persistMessage(query, msg);
		if (sessionGuard && !(await sessionGuard())) throw new Error('Session revoked before commit');
		return {
			row: {
				id: insertId,
				client_msg_id: msg.client_msg_id || null,
				room_seq: msg.room_seq || insertId,
				sender_id: msg.sender_id,
				receiver_id: msg.receiver_id,
				content: msg.content,
				room: msg.room,
				media_type: msg.media_type,
				file_size: msg.file_size,
				created_at: new Date(),
				avatar: null
			} as HistoryMessageRow,
			inserted: true
		};
	});

	const outbound: OutboundMessage = {
		...message,
		content: saved.row.content,
		sender_id: saved.row.sender_id,
		receiver_id: saved.row.receiver_id,
		type: saved.row.media_type,
		id: saved.row.id,
		client_msg_id: saved.row.client_msg_id,
		room_seq: Number(saved.row.room_seq || saved.row.id),
		created_at: new Date(saved.row.created_at).toLocaleString('zh-CN', {
			timeZone: 'Asia/Shanghai'
		}),
		file_size: formatBytes(saved.row.file_size)
	};

	if (saved.inserted) void flushMessageOutbox();
	return outbound;
};

export const sendConfirmedTextMessage = async (
	userId: number,
	room: string,
	type: ChatType,
	content: string,
	confirmationId: string
): Promise<void> => {
	if (!room || !content.trim() || content.length > MAX_MESSAGE_LENGTH || !confirmationId)
		throw new Error('Invalid message');
	const existing = await Query<Array<{ room: string; content: string }>>(
		'SELECT room, content FROM message WHERE sender_id = ? AND client_msg_id = ? LIMIT 1',
		[userId, confirmationId]
	);
	if (existing.length) {
		if (existing[0].room !== room || existing[0].content !== content.trim())
			throw new Error('Idempotency key conflict');
		return;
	}
	const authorized = await authorizeChatRoom(userId, room, type);
	if (!authorized) throw new Error('Room access denied');
	await writeAndSend(
		type,
		room,
		{
			sender_id: userId,
			receiver_id: authorized.receiverId,
			content: content.trim(),
			room,
			type,
			media_type: 'text',
			file_size: 0,
			status: 0,
			client_msg_id: confirmationId
		},
		{
			sender_id: userId,
			receiver_id: authorized.receiverId,
			content: content.trim(),
			room,
			type: 'text',
			file_size: 0
		}
	);
};
