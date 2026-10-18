import { Query } from '../infrastructure/database-query';
import type { SqlQuery } from '../shared/actor';
export const searchUsersWithFriendStatus = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`SELECT u.id, u.name, u.username, u.avatar,
			 EXISTS(SELECT 1 FROM friend f JOIN friend_group fg ON fg.id = f.group_id
			 WHERE fg.user_id = ? AND f.user_id = u.id) AS status
			 FROM user u WHERE u.username LIKE ? ESCAPE '!' AND u.id <> ? AND u.id > ?
			 ORDER BY u.id LIMIT ?`,
		bindings
	);
};

export const lockInviteeIdentity = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'SELECT id, username, avatar, name FROM user WHERE id = ? AND username = ? FOR UPDATE',
		bindings
	);
};

export const findFriendProfile = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`
			SELECT
				f.id AS friend_id,
				f.user_id AS friend_user_id,
				f.online_status,
				f.remark,
				f.group_id,
				fg.name AS group_name,
				f.room,
				f.unread_msg_count,
				u.username,
				u.avatar,
				u.phone,
				u.name,
				u.signature
			FROM
				friend AS f
			JOIN
				user AS u ON f.user_id = u.id
			JOIN
				friend_group AS fg ON f.group_id = fg.id
			WHERE
				f.id = ? AND fg.user_id = ?
		`,
		bindings
	);
};

export const listGroupMembersWithActivity = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`
			SELECT
				s.*,
				m.lastMessageTime
			FROM
				(SELECT
					user_id,
					user.avatar,
					user.username,
					user.name,
					nickname,
					group_members.created_at
				FROM group_members, user
				WHERE group_id = ? AND user_id = user.id
				) AS s
				LEFT JOIN
				(SELECT
					sender_id,
					Max(created_at) AS lastMessageTime
				FROM message AS msg
				WHERE msg.room = ?
				GROUP BY sender_id
				) AS m
				ON m.sender_id = s.user_id
		`,
		bindings
	);
};

export const findInviteeIdentities = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`SELECT id, username FROM user WHERE id IN (?)`, bindings);
};

export const findGroupWithCreator = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`
			SELECT
				gc.id,
				gc.name,
				gc.creator_id,
				u.username AS creator_username,
				gc.avatar,
				gc.announcement,
				gc.room,
				gc.created_at
			FROM group_chat gc
			JOIN user u
				ON gc.creator_id = u.id
			WHERE gc.id = ?
		`,
		bindings
	);
};

export const searchOwnedContactDirectory = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`
				SELECT
					f.user_id AS user_id,
					f.username,
					f.remark,
					f.room,
					u.name,
					u.signature
				FROM friend AS f
				INNER JOIN friend_group AS fg ON fg.id = f.group_id
				LEFT JOIN user AS u ON u.id = f.user_id
				WHERE fg.user_id = ? AND (f.username LIKE ? OR f.remark LIKE ? OR u.name LIKE ?)
				LIMIT 10
			`,
		bindings
	);
};

export const searchJoinedGroupDirectory = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`
				SELECT gc.id, gc.name, gc.room, gc.announcement
				FROM group_chat AS gc
				INNER JOIN group_members AS gm ON gm.group_id = gc.id
				WHERE gm.user_id = ? AND gc.name LIKE ?
				LIMIT 10
			`,
		bindings
	);
};
/** Resolve an explicit recipient only inside the actor's current memberships. */
export const findMessageRecipient = <T = unknown>(
	userId: number,
	room: string,
	type: 'private' | 'group'
): Promise<T> =>
	type === 'private'
		? Query<T>(
				`SELECT f.user_id AS receiverId, COALESCE(NULLIF(f.remark, ''), NULLIF(u.name, ''), f.username) AS name,
				 f.username AS username FROM friend f JOIN friend_group fg ON fg.id = f.group_id
				 JOIN user u ON u.id = f.user_id WHERE fg.user_id = ? AND f.room = ? LIMIT 1`,
				[userId, room]
			)
		: Query<T>(
				`SELECT g.id AS receiverId, g.name, NULL AS username FROM group_chat g
				 JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? AND g.room = ? LIMIT 1`,
				[userId, room]
			);
