import { Query } from '../../infrastructure/database-query';
import { ormQuery } from '../../infrastructure/prisma';
import type { Prisma } from '../../generated/prisma/client';
import type { SqlQuery } from '../../shared/actor';
export const findPublicProfile = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const args = bindings as unknown[];
	return ormQuery<T>(
		executor,
		db =>
			db.user.findMany({
				where: { id: Number(args[0]) },
				select: { id: true, username: true, name: true, avatar: true },
				take: 1
			}),
		() => executor<T>('SELECT id, username, name, avatar FROM user WHERE id = ? LIMIT 1', bindings)
	);
};

export const findUsernameById = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const args = bindings as unknown[];
	return ormQuery<T>(
		executor,
		db => db.user.findMany({ where: { id: Number(args[0]) }, select: { username: true } }),
		() => executor<T>('SELECT username FROM user WHERE id = ?', bindings)
	);
};

export const findUserByUsername = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const args = bindings as unknown[];
	return ormQuery<T>(
		executor,
		db => db.user.findMany({ where: { username: String(args[0]) } }),
		() => executor<T>(`SELECT * FROM user WHERE username = ?`, bindings)
	);
};

export const upgradePasswordHash = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const args = bindings as unknown[];
	return ormQuery<T>(
		executor,
		db =>
			db.user
				.updateMany({ where: { id: Number(args[1]) }, data: { password: String(args[0]) } })
				.then(result => ({ affectedRows: result.count })),
		() => executor<T>(`UPDATE user SET password = ? WHERE id = ?`, bindings)
	);
};

export const findRegistrationConflict = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const args = bindings as unknown[];
	return ormQuery<T>(
		executor,
		db =>
			db.user.findMany({
				where: { OR: [{ username: String(args[0]) }, { phone: String(args[1]) }] },
				select: { username: true, phone: true }
			}),
		() => executor<T>(`SELECT username, phone FROM user WHERE username = ? OR phone = ?`, bindings)
	);
};

export const insertUser = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return ormQuery<T>(
		executor,
		db =>
			db.user
				.create({ data: bindings as Prisma.userUncheckedCreateInput })
				.then(row => ({ insertId: row.id, affectedRows: 1 })),
		() => executor<T>('INSERT INTO user SET ?', bindings)
	);
};

export const findUserById = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const args = bindings as unknown[];
	return ormQuery<T>(
		executor,
		db => db.user.findMany({ where: { id: Number(args[0]) } }),
		() => executor<T>('SELECT * FROM user WHERE id = ?', bindings)
	);
};

export const findUserPassword = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const args = bindings as unknown[];
	return ormQuery<T>(
		executor,
		db =>
			db.user.findMany({ where: { id: Number(args[0]) }, select: { id: true, password: true } }),
		() => executor<T>(`SELECT id, password FROM user WHERE id = ?`, bindings)
	);
};

export const updateUserPassword = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const args = bindings as unknown[];
	return ormQuery<T>(
		executor,
		db =>
			db.user
				.updateMany({
					where: { id: Number(args[1]) },
					data: { password: String(args[0]), salt: '' }
				})
				.then(result => ({ affectedRows: result.count })),
		() => executor<T>(`UPDATE user SET password = ?, salt = '' WHERE id = ?`, bindings)
	);
};

export const findPhoneOwner = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const args = bindings as unknown[];
	return ormQuery<T>(
		executor,
		db => db.user.findMany({ where: { phone: String(args[0]) } }),
		() => executor<T>(`SELECT * FROM user WHERE phone = ?`, bindings)
	);
};

export const updateUserProfile = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const args = bindings as unknown[];
	return ormQuery<T>(
		executor,
		db =>
			db.user
				.updateMany({
					where: { username: String(args[1]) },
					data: args[0] as Prisma.userUpdateManyMutationInput
				})
				.then(result => ({ affectedRows: result.count })),
		() => executor<T>(`UPDATE user SET ? WHERE username = ?`, bindings)
	);
};

export const findUpdatedUser = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const args = bindings as unknown[];
	return ormQuery<T>(
		executor,
		db => db.user.findMany({ where: { username: String(args[0]) } }),
		() => executor<T>(`SELECT * FROM user WHERE username = ?`, bindings)
	);
};
