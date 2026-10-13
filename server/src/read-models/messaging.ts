import { Query } from '../infrastructure/database-query';
import type { SqlQuery } from '../shared/actor';
export const listPrivateChatSummaries = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`
			SELECT
				f.user_id AS receiver_id,
				f.remark AS name,
				u.username AS receiver_username,
				u.avatar,
				f.room,
				COALESCE(c.updated_at, msg_sta.updated_at, f.updated_at) AS updated_at,
				IFNULL(unread.cnt, 0) AS unreadCount,
				last_msg.content AS lastMessage,
				IFNULL(last_msg.media_type, 'text') AS type
			FROM friend AS f
			INNER JOIN friend_group AS fp ON fp.id = f.group_id AND fp.user_id = ?
			LEFT JOIN conversation AS c ON c.room = f.room
			LEFT JOIN message_statistics AS msg_sta ON f.room = msg_sta.room
			LEFT JOIN user AS u ON u.id = f.user_id
			LEFT JOIN (
				SELECT room, COUNT(*) AS cnt FROM message
				WHERE receiver_id = ? AND status = 0 GROUP BY room
			) AS unread ON unread.room = f.room
			LEFT JOIN message AS last_msg ON last_msg.id = c.last_message_id
			ORDER BY updated_at DESC;
		`,
		bindings
	);
};

export const listGroupChatSummaries = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`
			SELECT
				gc.id AS receiver_id,
				gc.avatar,
				gc.name,
				gc.room,
				COALESCE(c.updated_at, msg_sta.updated_at, gc.updated_at) AS updated_at,
				GREATEST(COALESCE(c.last_seq, 0) - COALESCE(cr.last_read_seq, 0), 0) AS unreadCount,
				last_msg.content AS lastMessage,
				IFNULL(last_msg.media_type, 'text') AS type
			FROM group_chat AS gc
			INNER JOIN group_members AS gm ON gm.group_id = gc.id AND gm.user_id = ?
			LEFT JOIN conversation AS c ON c.room = gc.room
			LEFT JOIN conversation_read AS cr ON cr.conversation_id = c.id AND cr.user_id = ?
			LEFT JOIN message_statistics AS msg_sta ON gc.room = msg_sta.room
			LEFT JOIN message AS last_msg ON last_msg.id = c.last_message_id
			ORDER BY updated_at DESC;
		`,
		bindings
	);
};

export const listHistoryAfterSequence = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'SELECT m.*, u.avatar FROM message m LEFT JOIN user u ON u.id = m.sender_id WHERE m.room = ? AND m.type = ? AND m.room_seq > ? ORDER BY m.room_seq ASC LIMIT ?',
		bindings
	);
};

export const listHistoryBeforeId = <T = unknown>(
	bindings: unknown,
	context: { hasCursor: boolean },
	executor: SqlQuery = Query
): Promise<T> => {
	const { hasCursor } = context;
	return executor<T>(
		`
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
	`,
		bindings
	);
};

export const searchMessagesInRoom = <T = unknown>(
	bindings: unknown,
	context: { conditions: string[]; options: { afterId?: number } },
	executor: SqlQuery = Query
): Promise<T> => {
	const { conditions, options } = context;
	return executor<T>(
		`SELECT m.*, u.avatar, u.username AS sender_username, u.name AS sender_name
 FROM message AS m LEFT JOIN user u ON u.id = m.sender_id WHERE ${conditions.join(' AND ')} ORDER BY m.id ${options.afterId ? 'ASC' : 'DESC'} LIMIT ?`,
		bindings
	);
};

export const findMessageInRoom = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`SELECT m.*, u.avatar, u.username AS sender_username, u.name AS sender_name
 FROM message AS m LEFT JOIN user u ON u.id = m.sender_id WHERE m.room = ? AND m.type = ? AND m.id = ? LIMIT 1`,
		bindings
	);
};

export const listNearbyMessages = <T = unknown>(
	bindings: unknown,
	context: { operator: '<' | '>' },
	executor: SqlQuery = Query
): Promise<T> => {
	const { operator } = context;
	return executor<T>(
		`SELECT m.*, u.avatar, u.username AS sender_username, u.name AS sender_name
 FROM message AS m LEFT JOIN user u ON u.id = m.sender_id WHERE m.room = ? AND m.type = ? AND m.id ${operator} ? ORDER BY m.id ${operator === '<' ? 'DESC' : 'ASC'} LIMIT ?`,
		bindings
	);
};

export const resolveOwnedMessageIds = <T = unknown>(
	bindings: unknown,
	context: { ids: string[] },
	executor: SqlQuery = Query
): Promise<T> => {
	const { ids } = context;
	return executor<T>(
		`SELECT m.*, u.avatar, u.username AS sender_username, u.name AS sender_name
 FROM message AS m LEFT JOIN user u ON u.id = m.sender_id WHERE m.room = ? AND m.type = ? AND m.sender_id = ? AND m.client_msg_id IN (${ids.map(() => '?').join(',')})`,
		bindings
	);
};

export const listRecentMessages = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`SELECT m.*, u.avatar, u.username AS sender_username, u.name AS sender_name
 FROM message AS m LEFT JOIN user u ON u.id = m.sender_id WHERE m.room = ? AND m.type = ? ORDER BY m.id DESC LIMIT ?`,
		bindings
	);
};

export const findMessageContextTarget = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`SELECT m.*, u.avatar, u.username AS sender_username, u.name AS sender_name
 FROM message AS m LEFT JOIN user u ON u.id = m.sender_id WHERE m.id = ? LIMIT 1`,
		bindings
	);
};
