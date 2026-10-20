import * as repository from './repository';
import * as readModel from '../../read-models/messaging';
import { withTransaction } from '../../infrastructure/database-query';
import { formatBytes } from '../../shared/format';
import { formatTimestamp } from '../../shared/time';
import { authorizeChatRoom } from '../social/public';
import {
	HISTORY_PAGE_SIZE,
	MAX_HISTORY_PAGE_SIZE,
	type HistoryMessageRow,
	type UserId,
	type ChatType
} from './contracts';
export const formatHistoryMessages = (rows: HistoryMessageRow[]) =>
	rows.map(item => ({
		id: item.id,
		client_msg_id: item.client_msg_id,
		room_seq: Number(item.room_seq || item.id),
		sender_id: item.sender_id,
		receiver_id: item.receiver_id,
		content: item.content,
		file_name: item.file_name || null,
		room: item.room,
		avatar: item.avatar,
		type: item.media_type,
		file_size: formatBytes(item.file_size),
		created_at: formatTimestamp(item.created_at)
	}));

export const fetchHistoryMessages = async (
	userId: UserId,
	room: string,
	type: ChatType,
	beforeId?: number,
	limit = HISTORY_PAGE_SIZE,
	afterSeq?: number
) => {
	const authorized = await authorizeChatRoom(userId, room, type);
	if (!authorized) return null;
	const peerCursor =
		type === 'private'
			? await readModel.loadReadCursor<Array<{ last_read_seq: number }>>([
					room,
					authorized.receiverId
				])
			: [];
	const peerReadSeq = Number(peerCursor[0]?.last_read_seq || 0);
	const safeLimit = Math.max(
		1,
		Math.min(Math.floor(Number(limit) || HISTORY_PAGE_SIZE), MAX_HISTORY_PAGE_SIZE)
	);
	const hasCursor = Number.isInteger(beforeId) && Number(beforeId) > 0;
	if (Number.isSafeInteger(afterSeq) && Number(afterSeq) >= 0) {
		const page = await readModel.listHistoryAfterSequence<HistoryMessageRow[]>([
			room,
			type,
			afterSeq,
			safeLimit + 1
		]);
		const rows = page.slice(0, safeLimit);
		return {
			authorized,
			peerReadSeq,
			messages: formatHistoryMessages(rows),
			hasMore: page.length > safeLimit,
			nextBeforeId: rows[0]?.id,
			nextAfterSeq: rows.length ? Number(rows[rows.length - 1].room_seq) : afterSeq
		};
	}

	const params = hasCursor ? [room, type, beforeId, safeLimit + 1] : [room, type, safeLimit + 1];
	const page = await readModel.listHistoryBeforeId<HistoryMessageRow[]>(params, { hasCursor });
	const rows = page.slice(Math.max(0, page.length - safeLimit));
	return {
		authorized,
		peerReadSeq,
		messages: formatHistoryMessages(rows),
		hasMore: page.length > safeLimit,
		nextBeforeId: rows[0]?.id,
		nextAfterSeq: undefined
	};
};

export const markRoomRead = async (
	userId: UserId,
	room: string,
	type: ChatType,
	roomSeq?: number
): Promise<number> => {
	if (!Number.isSafeInteger(roomSeq) || Number(roomSeq) < 0)
		throw new Error('Invalid read sequence');
	return withTransaction(async query => {
		const rows = await repository.lockReadCursorConversation<
			Array<{ id: number; last_seq: number }>
		>([room], query);
		if (!rows.length) return 0;
		const seq = Math.min(Number(roomSeq), Number(rows[0].last_seq));
		await repository.advanceReadCursor([rows[0].id, userId, seq], query);
		await repository.markPrivateMessagesRead([userId, room, type, seq], query);
		const cursor = await readModel.loadReadCursor<Array<{ last_read_seq: number }>>(
			[room, userId],
			query
		);
		return Number(cursor[0]?.last_read_seq || 0);
	});
};
