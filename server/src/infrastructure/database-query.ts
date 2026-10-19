import { prisma, bindOrmExecutor, databaseError } from './prisma';
import { executeSql } from './prisma-sql';
import { assertSafeTestDatabaseConfiguration } from './database-config';
import type { SqlQuery } from '../shared/actor';

export const Query: SqlQuery = bindOrmExecutor(
	async <T>(sql: string, info?: unknown): Promise<T> => {
		assertSafeTestDatabaseConfiguration();
		try {
			if (/^\s*INSERT\b/i.test(sql))
				return await prisma.$transaction(tx => executeSql<T>(tx, sql, info));
			return await executeSql<T>(prisma, sql, info);
		} catch (error) {
			throw databaseError(error);
		}
	},
	prisma
);

const withTransactionOnce = async <T>(fn: (query: SqlQuery) => Promise<T>): Promise<T> => {
	assertSafeTestDatabaseConfiguration();
	try {
		return await prisma.$transaction(async tx => {
			const query = bindOrmExecutor(
				<R>(sql: string, info?: unknown) => executeSql<R>(tx, sql, info),
				tx
			);
			return fn(query);
		});
	} catch (error) {
		throw databaseError(error);
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
