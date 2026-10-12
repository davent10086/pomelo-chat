import { Query, withTransaction } from '../../utils/query';
import { formatBytes } from '../../utils/format';
import { authorizeChatRoom } from './permissions';
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
		room: item.room,
		avatar: item.avatar,
		type: item.media_type,
		file_size: formatBytes(item.file_size),
		created_at: new Date(item.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
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
	const safeLimit = Math.max(
		1,
		Math.min(Math.floor(Number(limit) || HISTORY_PAGE_SIZE), MAX_HISTORY_PAGE_SIZE)
	);
	const hasCursor = Number.isInteger(beforeId) && Number(beforeId) > 0;
	if (Number.isSafeInteger(afterSeq) && Number(afterSeq) >= 0) {
		const rows = await Query<HistoryMessageRow[]>(
			'SELECT m.*, u.avatar FROM message m LEFT JOIN user u ON u.id = m.sender_id WHERE m.room = ? AND m.type = ? AND m.room_seq > ? ORDER BY m.room_seq ASC LIMIT ?',
			[room, type, afterSeq, safeLimit]
		);
		return {
			authorized,
			messages: formatHistoryMessages(rows),
			hasMore: rows.length === safeLimit,
			nextBeforeId: rows[0]?.id
		};
	}
	const sql = `
		SELECT page.*, u.avatar
		FROM (
			SELECT
				id,
				client_msg_id,
				CASE WHEN room_seq = 0 THEN id ELSE room_seq END AS room_seq,
				sender_id,
				receiver_id,
				content,
				room,
				media_type,
				file_size,
				created_at
			FROM message
			WHERE room = ? AND type = ? ${hasCursor ? 'AND id < ?' : ''}
			ORDER BY id DESC
			LIMIT ?
		) AS page
		LEFT JOIN user AS u ON u.id = page.sender_id
		ORDER BY page.id ASC
	`;
	const params = hasCursor ? [room, type, beforeId, safeLimit] : [room, type, safeLimit];
	const rows = await Query<HistoryMessageRow[]>(sql, params);
	return {
		authorized,
		messages: formatHistoryMessages(rows),
		hasMore: rows.length === safeLimit,
		nextBeforeId: rows[0]?.id
	};
};

export const markRoomRead = async (
	userId: UserId,
	room: string,
	type: ChatType,
	roomSeq?: number
): Promise<void> => {
	if (!Number.isSafeInteger(roomSeq) || Number(roomSeq) < 0)
		throw new Error('Invalid read sequence');
	await withTransaction(async query => {
		const rows = await query<Array<{ id: number; last_seq: number }>>(
			'SELECT id, last_seq FROM conversation WHERE room = ? FOR UPDATE',
			[room]
		);
		if (!rows.length) return;
		const seq = Math.min(Number(roomSeq), Number(rows[0].last_seq));
		await query(
			'INSERT INTO conversation_read (conversation_id, user_id, last_read_seq) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_read_seq = GREATEST(last_read_seq, VALUES(last_read_seq)), updated_at = CURRENT_TIMESTAMP',
			[rows[0].id, userId, seq]
		);
		await query(
			'UPDATE message SET status = 1 WHERE receiver_id = ? AND room = ? AND type = ? AND status = 0 AND room_seq <= ?',
			[userId, room, type, seq]
		);
	});
};
