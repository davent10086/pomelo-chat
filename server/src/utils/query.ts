import db from '../model/db';
import type { QueryOptions } from 'mysql';
import type { PoolConnection } from 'mysql';

// 封装统一的 sql 语句执行函数
export const Query = <T>(sql: string, info?: unknown): Promise<T> => {
	return new Promise((resolve, reject) => {
		db.query(sql, info as QueryOptions, (err, results) => {
			if (err) return reject(err);
			resolve(results as T);
		});
	});
};

export const withTransaction = async <T>(
	fn: (query: <R>(sql: string, info?: unknown) => Promise<R>) => Promise<T>
): Promise<T> => {
	const connection = await new Promise<PoolConnection>((resolve, reject) => {
		db.getConnection((err, conn) => (err ? reject(err) : resolve(conn)));
	});
	const query = <R>(sql: string, info?: unknown): Promise<R> =>
		new Promise((resolve, reject) => {
			connection.query(sql, info as QueryOptions, (err, results) => {
				if (err) return reject(err);
				resolve(results as R);
			});
		});
	try {
		await new Promise<void>((resolve, reject) => {
			connection.beginTransaction(err => (err ? reject(err) : resolve()));
		});
		const result = await fn(query);
		await new Promise<void>((resolve, reject) => {
			connection.commit(err => (err ? reject(err) : resolve()));
		});
		return result;
	} catch (error) {
		await new Promise<void>(resolve => {
			connection.rollback(() => resolve());
		});
		throw error;
	} finally {
		connection.release();
	}
};
