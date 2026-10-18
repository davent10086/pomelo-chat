import * as repository from './repository';
import { withTransaction } from '../../infrastructure/database-query';
import { formatBytes } from '../../shared/format';
import { persistMessage } from './persistence';
import { flushMessageOutbox } from './outbox';
import { admitMessage } from './pressure';
import { authorizeChatRoom } from '../social/public';
import {
	MAX_MESSAGE_LENGTH,
	enqueueRoomWrite,
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
	// Bootstrap outside the transaction: existing rooms must not take insert/upsert locks.
	const existingConversation = await repository.findWriteConversation<
		Array<{ id: number; statistics_room: string | null }>
	>([room]);
	// Preserve resolution of already committed retries even while rejecting new writes.
	const prior = msg.client_msg_id
		? await repository.findMessageByClientId<HistoryMessageRow[]>([
				msg.sender_id,
				msg.client_msg_id
			])
		: [];
	if (!prior.length) await admitMessage(msg.sender_id, room, type, existingConversation[0]?.id);
	if (!existingConversation.length)
		await repository.ensureWriteConversation([room, type, msg.receiver_id]);
	if (!existingConversation[0]?.statistics_room) await repository.ensureMessageStatistics([room]);
	const saved = await withTransaction(
		async query => {
			const conversations = await repository.lockWriteConversation<
				Array<{ id: number; last_seq: number }>
			>([room], query);
			if (!conversations.length) throw new Error('Conversation not found');
			if (sessionGuard && !(await sessionGuard()))
				throw new Error('Session revoked while waiting for transaction');
			if (msg.client_msg_id) {
				const existing = await repository.findMessageByClientId<HistoryMessageRow[]>(
					[msg.sender_id, msg.client_msg_id],
					query
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
			const insertId = await persistMessage(query, msg, conversations[0]);
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
		},
		{ maxAttempts: 3, retryDuplicateKey: 'uniq_message_client' }
	);

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
	const existing = await repository.findConfirmedMessage<Array<{ room: string; content: string }>>([
		userId,
		confirmationId
	]);
	if (existing.length) {
		if (existing[0].room !== room || existing[0].content !== content.trim())
			throw new Error('Idempotency key conflict');
		return;
	}
	await enqueueRoomWrite(room, async () => {
		const authorized = await authorizeChatRoom(userId, room, type);
		if (!authorized) throw new Error('Room access denied');
		return writeAndSend(
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
	});
};
