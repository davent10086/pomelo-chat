import { Query } from '../../infrastructure/database-query';
import type { SqlQuery } from '../../shared/actor';
export const findPublicProfile = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> =>
	executor<T>('SELECT id, username, name, avatar FROM user WHERE id = ? LIMIT 1', bindings);
export const findUsernameById = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => executor<T>('SELECT username FROM user WHERE id = ?', bindings);
export const findUserByUsername = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`SELECT * FROM user WHERE username = ?`, bindings);
};

export const upgradePasswordHash = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`UPDATE user SET password = ? WHERE id = ?`, bindings);
};

export const findRegistrationConflict = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`SELECT username, phone FROM user WHERE username = ? OR phone = ?`, bindings);
};

export const insertUser = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('INSERT INTO user SET ?', bindings);
};

export const findUserById = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>('SELECT * FROM user WHERE id = ?', bindings);
};

export const findUserPassword = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`SELECT id, password FROM user WHERE id = ?`, bindings);
};

export const updateUserPassword = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`UPDATE user SET password = ?, salt = '' WHERE id = ?`, bindings);
};

export const findPhoneOwner = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`SELECT * FROM user WHERE phone = ?`, bindings);
};

export const updateUserProfile = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`UPDATE user SET ? WHERE username = ?`, bindings);
};

export const findUpdatedUser = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(`SELECT * FROM user WHERE username = ?`, bindings);
};
