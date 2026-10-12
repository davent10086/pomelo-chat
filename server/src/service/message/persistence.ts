import type { SqlQuery } from '../../utils/attachments';
import { attachOwnedFile } from '../../utils/attachments';

export interface PersistedMessage {
	sender_id: number | string;
	receiver_id: number | string;
	content: string;
	room: string;
	type: 'private' | 'group';
	media_type: 'text' | 'image' | 'video' | 'file';
	file_size: number;
	status: number;
	client_msg_id?: string | null;
	conversation_id?: number;
	room_seq?: number;
}

/** Shared by ordinary messages and group initialization, inside the caller's transaction. */
export const persistMessage = async (query: SqlQuery, msg: PersistedMessage): Promise<number> => {
	await query('INSERT IGNORE INTO conversation (room, type, target_id) VALUES (?, ?, ?)', [
		msg.room,
		msg.type,
		msg.receiver_id
	]);
	const rows = await query<Array<{ id: number; last_seq: number }>>(
		'SELECT id, last_seq FROM conversation WHERE room = ? FOR UPDATE',
		[msg.room]
	);
	if (!rows.length) throw new Error('Conversation not found');
	msg.conversation_id = rows[0].id;
	msg.room_seq = Number(rows[0].last_seq) + 1;
	const result = await query<{ insertId: number }>('INSERT INTO message SET ?', msg);
	if (msg.media_type !== 'text') {
		msg.file_size = await attachOwnedFile(
			query,
			result.insertId,
			msg.sender_id,
			msg.content,
			msg.media_type
		);
		await query('UPDATE message SET file_size = ? WHERE id = ?', [msg.file_size, result.insertId]);
	}
	await query(
		'UPDATE conversation SET last_seq = ?, last_message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
		[msg.room_seq, result.insertId, msg.conversation_id]
	);
	await query(
		'INSERT INTO message_statistics (room, total) VALUES (?, 1) ON DUPLICATE KEY UPDATE total = total + 1',
		[msg.room]
	);
	await query('INSERT INTO message_outbox (message_id) VALUES (?)', [result.insertId]);
	return result.insertId;
};
