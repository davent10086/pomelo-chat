import { Query } from '../../infrastructure/database-query';
import type { SqlQuery } from '../../shared/actor';
import { ormQuery } from '../../infrastructure/prisma';
import type { Prisma } from '../../generated/prisma/client';
export const findPresenceObservers = (bindings: unknown): Promise<Array<{ username: string }>> =>
	Query('SELECT DISTINCT u.username FROM friend f JOIN friend_group fg ON fg.id = f.group_id JOIN user u ON u.id = fg.user_id WHERE f.username = ?', bindings);
export const findAccessibleGroupMembers = (room: string, users: Array<number | string>): Promise<Array<{ user_id: number }>> =>
	Query('SELECT gm.user_id FROM group_members gm JOIN group_chat gc ON gc.id = gm.group_id WHERE gc.room = ? AND gm.user_id IN (?)', [room, users]);
export const lockContactGroups = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'SELECT id, user_id FROM friend_group WHERE user_id IN (?, ?) ORDER BY user_id, id FOR UPDATE',
		bindings
	);
};

export const lockExistingFriendship = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'SELECT id FROM friend WHERE (owner_id = ? AND user_id = ?) OR (owner_id = ? AND user_id = ?) FOR UPDATE',
		bindings
	);
};

export const insertFriend = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('INSERT INTO friend SET ?', bindings);
};

export const insertReciprocalFriend = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('INSERT INTO friend SET ?', bindings);
};

export const listFriendGroupNames = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`SELECT id, name FROM friend_group WHERE user_id = ?`, bindings);
};

export const listFriendsByOwner = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		'SELECT f.* FROM friend f JOIN friend_group fg ON fg.id = f.group_id WHERE fg.user_id = ? ORDER BY f.id',
		bindings
	);
};

export const listFriendGroups = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`SELECT * FROM friend_group WHERE user_id = ?`, bindings);
};

export const insertFriendGroup = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`INSERT INTO friend_group SET ?`, bindings);
};

export const updateOwnedFriend = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`UPDATE friend AS f JOIN friend_group AS target ON target.id = ? AND target.user_id = ? JOIN friend_group AS owner ON owner.id = f.group_id AND owner.user_id = ? SET f.remark = ?, f.group_id = ? WHERE f.id = ?`,
		bindings
	);
};

export const findGroupMembership = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1`,
		bindings
	);
};

export const findInviteeContacts = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`SELECT f.user_id FROM friend f INNER JOIN friend_group fg ON fg.id = f.group_id WHERE fg.user_id = ? AND f.user_id IN (?)`,
		bindings
	);
};

export const insertGroup = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('INSERT INTO group_chat SET ?', bindings);
};

export const insertInitialGroupMembers = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('INSERT INTO group_members (group_id, user_id, nickname) VALUES ?', bindings);
};

export const listJoinedGroupRecords = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`
			SELECT
				gct.*
			FROM
				(
					(
						SELECT
							group_id
						FROM
							group_members
						WHERE
							user_id = ?
					) AS gmb
					LEFT JOIN group_chat AS gct ON gmb.group_id = gct.id
				)
		`,
		bindings
	);
};

export const searchGroupDirectory = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`SELECT gc.id AS group_id, gc.name, gc.avatar,
			 (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = gc.id) AS number,
			 EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id = gc.id AND gm.user_id = ?) AS status
			 FROM group_chat gc WHERE gc.name LIKE ? ESCAPE '!' AND gc.id > ? ORDER BY gc.id LIMIT ?`,
		bindings
	);
};

export const findExistingInvitees = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`
			SELECT user_id
			FROM group_members
			WHERE group_id = ? AND FIND_IN_SET(user_id, ?)
		`,
		bindings
	);
};

export const insertInvitedGroupMembers = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`INSERT INTO group_members (group_id, user_id, nickname) VALUES ?`, bindings);
};

export const findExistingMembership = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`SELECT id FROM group_members WHERE group_id = ? AND user_id = ?`, bindings);
};

export const insertGroupMembership = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`INSERT INTO group_members SET ?`, bindings);
};

export const findGroupRoomAndName = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`SELECT name, room FROM group_chat WHERE id = ?`, bindings);
};

export const findGroupRoom = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`SELECT room FROM group_chat WHERE id = ?`, bindings);
};

export const findAccessibleGroupRoom = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const [userId, room] = bindings as [number | string, string];
	return ormQuery<T>(
		executor,
		db =>
			db.group_chat.findMany({
				where: { room, group_members: { some: { user_id: Number(userId) } } },
				select: { id: true },
				take: 1
			}),
		() =>
			executor<T>(
				`SELECT gc.id FROM group_chat AS gc INNER JOIN group_members AS gm ON gm.group_id = gc.id WHERE gm.user_id = ? AND gc.room = ? LIMIT 1`,
				bindings
			)
	);
};

export const findAccessiblePrivateRoom = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const [userId, room] = bindings as [number | string, string];
	return ormQuery<T>(
		executor,
		db =>
			db.friend.findMany({
				where: { room, friend_group: { is: { user_id: Number(userId) } } },
				select: { user_id: true },
				take: 1
			}),
		() =>
			executor<T>(
				`SELECT f.user_id FROM friend AS f INNER JOIN friend_group AS fg ON fg.id = f.group_id WHERE fg.user_id = ? AND f.room = ? LIMIT 1`,
				bindings
			)
	);
};

export const updateFriendPresence = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('UPDATE friend SET online_status = ? WHERE username = ?', bindings);
};

export const insertDefaultFriendGroup = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return ormQuery<T>(
		executor,
		db =>
			db.friend_group
				.create({ data: bindings as Prisma.friend_groupUncheckedCreateInput })
				.then(row => ({ insertId: row.id, affectedRows: 1 })),
		() => executor<T>('INSERT INTO friend_group SET ?', bindings)
	);
};
