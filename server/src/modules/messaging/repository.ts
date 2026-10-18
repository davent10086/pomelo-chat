import { Query } from '../../infrastructure/database-query';
import type { SqlQuery } from '../../shared/actor';
export const claimOutboxRows = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'UPDATE message_outbox SET claim_token = ?, lease_until = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE message_id IN (?)',
		bindings
	);
};

export const renewOutboxLease = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'UPDATE message_outbox SET lease_until = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE message_id = ? AND claim_token = ? AND delivered_at IS NULL',
		bindings
	);
};

export const completeOutboxClaim = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'UPDATE message_outbox SET delivered_at = NOW(), claim_token = NULL, lease_until = NULL WHERE message_id = ? AND claim_token = ?',
		bindings
	);
};

export const retryOutboxClaim = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`UPDATE message_outbox SET attempts = attempts + 1,
				 next_attempt_at = DATE_ADD(NOW(), INTERVAL LEAST(60, POW(2, LEAST(attempts, 6))) SECOND),
				 claim_token = NULL, lease_until = NULL WHERE message_id = ? AND claim_token = ?`,
		bindings
	);
};

export const ensureConversation = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'INSERT INTO conversation (room, type, target_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE id = id',
		bindings
	);
};

export const lockConversationSequence = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('SELECT id, last_seq FROM conversation WHERE room = ? FOR UPDATE', bindings);
};

export const insertMessage = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('INSERT INTO message SET ?', bindings);
};

export const insertMessageAttachment = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'INSERT INTO message_attachment (message_id, file_id) VALUES (?, ?)',
		bindings
	);
};

export const updateMessageFileSize = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('UPDATE message SET file_size = ? WHERE id = ?', bindings);
};

export const advanceConversation = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'UPDATE conversation SET last_seq = ?, last_message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
		bindings
	);
};

export const incrementMessageStatistics = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'INSERT INTO message_statistics (room, total) VALUES (?, 1) ON DUPLICATE KEY UPDATE total = total + 1',
		bindings
	);
};

export const insertMessageOutbox = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('INSERT INTO message_outbox (message_id) VALUES (?)', bindings);
};

export const lockReadCursorConversation = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('SELECT id, last_seq FROM conversation WHERE room = ? FOR UPDATE', bindings);
};

export const advanceReadCursor = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'INSERT INTO conversation_read (conversation_id, user_id, last_read_seq) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_read_seq = GREATEST(last_read_seq, VALUES(last_read_seq)), updated_at = CURRENT_TIMESTAMP',
		bindings
	);
};

export const markPrivateMessagesRead = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'UPDATE message SET status = 1 WHERE receiver_id = ? AND room = ? AND type = ? AND status = 0 AND room_seq <= ?',
		bindings
	);
};

export const ensureWriteConversation = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'INSERT INTO conversation (room, type, target_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE id = id',
		bindings
	);
};

export const lockWriteConversation = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('SELECT id, last_seq FROM conversation WHERE room = ? FOR UPDATE', bindings);
};

export const findMessageByClientId = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`SELECT id, client_msg_id, room_seq, sender_id, receiver_id, content, room, media_type, file_size, created_at, NULL AS avatar
				 FROM message WHERE sender_id = ? AND client_msg_id = ? LIMIT 1`,
		bindings
	);
};

export const findConfirmedMessage = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'SELECT room, content FROM message WHERE sender_id = ? AND client_msg_id = ? LIMIT 1',
		bindings
	);
};

export const lockAvailableOutboxHead = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`SELECT o.message_id FROM message_outbox o JOIN message m ON m.id = o.message_id
						 WHERE o.delivered_at IS NULL AND o.next_attempt_at <= NOW()
						 AND (o.lease_until IS NULL OR o.lease_until <= NOW())
						 AND NOT EXISTS (
						   SELECT 1 FROM message earlier JOIN message_outbox previous ON previous.message_id = earlier.id
						   WHERE earlier.room = m.room AND earlier.id < m.id AND previous.delivered_at IS NULL
						 ) ORDER BY o.message_id LIMIT ? FOR UPDATE SKIP LOCKED`,
		bindings
	);
};

/** Read-only preflight; locking sequence reads still happen inside the write transaction. */
export const findWriteConversation = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> =>
	executor<T>(
		'SELECT c.id, s.room AS statistics_room FROM conversation c LEFT JOIN message_statistics s ON s.room = c.room WHERE c.room = ? LIMIT 1',
		bindings
	);
export const ensureMessageStatistics = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> =>
	executor<T>(
		'INSERT INTO message_statistics (room, total) VALUES (?, 0) ON DUPLICATE KEY UPDATE room = room',
		bindings
	);
export const incrementExistingMessageStatistics = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> =>
	executor<T>('UPDATE message_statistics SET total = total + 1 WHERE room = ?', bindings);
