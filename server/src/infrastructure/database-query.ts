import db from './database';
import type { PoolConnection, QueryValues } from 'mysql2';

// 封装统一的 sql 语句执行函数
export const Query = <T>(sql: string, info?: unknown): Promise<T> => {
	return new Promise((resolve, reject) => {
		db.query(sql, info as QueryValues, (err, results) => {
			if (err) return reject(err);
			resolve(results as T);
		});
	});
};

const withTransactionOnce = async <T>(
	fn: (query: <R>(sql: string, info?: unknown) => Promise<R>) => Promise<T>
): Promise<T> => {
	const connection = await new Promise<PoolConnection>((resolve, reject) => {
		db.getConnection((err, conn) => (err ? reject(err) : resolve(conn)));
	});
	const query = <R>(sql: string, info?: unknown): Promise<R> =>
		new Promise((resolve, reject) => {
			connection.query(sql, info as QueryValues, (err, results) => {
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

/** Retry only errors whose transaction was rolled back, never ambiguous connection/commit failures. */
export const withTransaction = async <T>(
	fn: (query: <R>(sql: string, info?: unknown) => Promise<R>) => Promise<T>,
	options: { maxAttempts?: number; retryDuplicateKey?: string } = {}
): Promise<T> => {
	const maxAttempts = Math.max(1, Math.min(3, options.maxAttempts || 1));
	for (let attempt = 1; ; attempt++) {
		try {
			return await withTransactionOnce(fn);
		} catch (error) {
			const failure = error as { code?: string; errno?: number; message?: string };
			const deadlock = failure.code === 'ER_LOCK_DEADLOCK' || failure.errno === 1213;
			const duplicate =
				failure.code === 'ER_DUP_ENTRY' &&
				options.retryDuplicateKey &&
				failure.message?.includes(options.retryDuplicateKey);
			if (attempt >= maxAttempts || (!deadlock && !duplicate)) throw error;
			await new Promise(resolve =>
				setTimeout(resolve, 10 * attempt + Math.floor(Math.random() * 10))
			);
		}
	}
};
