import { Query } from '../infrastructure/database-query';
import type { SqlQuery } from '../shared/actor';
export const loadMessageForDelivery = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'SELECT m.*, u.avatar FROM message m LEFT JOIN user u ON u.id = m.sender_id WHERE m.id = ?',
		bindings
	);
};

export const listGroupDeliveryRecipients = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'SELECT u.username FROM group_members gm JOIN user u ON u.id = gm.user_id WHERE gm.group_id = ? AND gm.user_id <> ?',
		bindings
	);
};
