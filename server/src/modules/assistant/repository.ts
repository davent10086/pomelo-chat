import { Query } from '../../infrastructure/database-query';
import type { SqlQuery } from '../../shared/actor';
export const findOwnedAction = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`SELECT id, user_id AS userId, type, payload, selection, result, status,
	 expires_at AS expiresAt, lease_until AS leaseUntil FROM assistant_action WHERE id = ? AND user_id = ?`,
		bindings
	);
};

export const findOwnedMemory = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'SELECT id, content FROM assistant_memory WHERE user_id = ? AND id = ? LIMIT 1',
		bindings
	);
};

export const insertPendingAction = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`INSERT INTO assistant_action (id, user_id, type, payload, expires_at) VALUES (?, ?, ?, ?, FROM_UNIXTIME(?))`,
		bindings
	);
};

export const listOwnedTasks = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`SELECT id, title, assignee, due, status, source_room AS sourceRoom, created_at AS createdAt, updated_at AS updatedAt
		 FROM assistant_task WHERE user_id = ? ORDER BY status ASC, updated_at DESC`,
		bindings
	);
};

export const insertTaskIdempotently = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`INSERT INTO assistant_task (user_id, source_room, confirmation_id, source_index, title, assignee, due)
			 VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
		bindings
	);
};

export const findTaskByConfirmation = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'SELECT id FROM assistant_task WHERE user_id = ? AND confirmation_id = ? AND source_index = ?',
		bindings
	);
};

export const claimPendingAction = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`UPDATE assistant_action SET status = 'executing', selection = ?, lease_until = DATE_ADD(NOW(), INTERVAL 45 SECOND)
				 WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > NOW()`,
		bindings
	);
};

export const reclaimExecutingAction = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`UPDATE assistant_action SET lease_until = DATE_ADD(NOW(), INTERVAL 45 SECOND)
				 WHERE id = ? AND user_id = ? AND status = 'executing' AND (lease_until IS NULL OR lease_until <= NOW())`,
		bindings
	);
};

export const completeAction = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`UPDATE assistant_action SET status = 'completed', result = ?, lease_until = NULL WHERE id = ? AND user_id = ?`,
		bindings
	);
};

export const expireExecutionLease = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`UPDATE assistant_action SET lease_until = NOW() WHERE id = ? AND user_id = ? AND status = 'executing'`,
		bindings
	);
};

export const cancelPendingAction = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`UPDATE assistant_action SET status = 'cancelled'
			 WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > NOW()`,
		bindings
	);
};

export const updateOwnedTaskStatus = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('UPDATE assistant_task SET status = ? WHERE id = ? AND user_id = ?', bindings);
};

export const insertMcpAudit = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`INSERT INTO mcp_audit_log
		 (user_id, server_name, tool, event, requires_confirmation, confirmed, status, error_message)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		bindings
	);
};

export const listFilteredTasks = <T = unknown>(
	bindings: unknown,
	context: { conditions: string[] },
	executor: SqlQuery = Query
): Promise<T> => {
	const { conditions } = context;
	return executor<T>(
		`SELECT id, title, assignee, due, status, source_room AS sourceRoom
				 FROM assistant_task WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`,
		bindings
	);
};

export const searchOwnedMemories = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`
				SELECT id, category, content, created_at, updated_at
				FROM assistant_memory
				WHERE user_id = ? AND (? = '' OR content LIKE ? OR category LIKE ?)
				ORDER BY updated_at DESC
				LIMIT ?
			`,
		bindings
	);
};

export const saveMemoryIdempotently = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'INSERT INTO assistant_memory (user_id, category, content, confirmation_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
		bindings
	);
};

export const deleteOwnedMemory = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('DELETE FROM assistant_memory WHERE user_id = ? AND id = ?', bindings);
};
