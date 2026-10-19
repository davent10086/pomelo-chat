import { Query } from '../infrastructure/database-query';
import type { SqlQuery } from '../shared/actor';
export const listPresenceRecipients = <T = unknown>(bindings: unknown): Promise<T> =>
	Query<T>(`SELECT DISTINCT owner.username FROM user changed
		JOIN friend f ON f.user_id = changed.id JOIN user owner ON owner.id = f.owner_id
		WHERE changed.username = ?`, bindings);
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
