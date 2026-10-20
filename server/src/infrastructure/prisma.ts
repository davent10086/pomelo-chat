import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient, Prisma } from '../generated/prisma/client';
import { databaseSettings, assertSafeTestDatabaseConfiguration } from './database-config';
import type { SqlQuery } from '../shared/actor';

// Prisma owns the business-query pool. mysql2 remains only for schema upgrades/test fixtures.
const adapter = new PrismaMariaDb({
	...databaseSettings,
	connectionLimit: databaseSettings.connectionLimit,
	connectTimeout: 5000,
	acquireTimeout: 5000,
	socketTimeout: 10000,
	foundRows: true
	, initSql: "SET time_zone = '+08:00'"
});
/** Prisma encodes SQL wall-clock fields as UTC; mysql2 previously interpreted them as local. */
export const encodeDatabaseValues = <T>(value: T): T => {
	if (value instanceof Date)
		return new Date(
			Date.UTC(
				value.getFullYear(),
				value.getMonth(),
				value.getDate(),
				value.getHours(),
				value.getMinutes(),
				value.getSeconds(),
				value.getMilliseconds()
			)
		) as T;
	if (Array.isArray(value)) return value.map(encodeDatabaseValues) as T;
	if (
		value &&
		typeof value === 'object' &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	)
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [key, encodeDatabaseValues(child)])
		) as T;
	return value;
};
export const prisma = new PrismaClient({
	adapter,
	transactionOptions: { maxWait: 5000, timeout: 15000 }
}).$extends({
	query: {
		$allModels: {
			async $allOperations({ args, query }) {
				return query(encodeDatabaseValues(args));
			}
		}
	}
});
export type OrmClient = Omit<
	typeof prisma,
	'$connect' | '$disconnect' | '$on' | '$transaction' | '$extends' | '$use'
>;
const executors = new WeakMap<SqlQuery, OrmClient>();
export const bindOrmExecutor = (query: SqlQuery, client: OrmClient): SqlQuery => {
	executors.set(query, client);
	return query;
};

/** Preserve public numeric IDs/cursors without silently rounding a BIGINT. */
export const normalizeDatabaseValue = (value: unknown): unknown => {
	if (typeof value === 'bigint') {
		const number = Number(value);
		if (!Number.isSafeInteger(number))
			throw new RangeError('Database integer exceeds API safe range');
		return number;
	}
	if (Array.isArray(value)) return value.map(normalizeDatabaseValue);
	if (value instanceof Date)
		return new Date(
			value.getUTCFullYear(),
			value.getUTCMonth(),
			value.getUTCDate(),
			value.getUTCHours(),
			value.getUTCMinutes(),
			value.getUTCSeconds(),
			value.getUTCMilliseconds()
		);
	if (value instanceof Uint8Array || value === null) return value;
	if (value instanceof Prisma.Decimal) return value.toNumber();
	if (typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [key, normalizeDatabaseValue(child)])
		);
	return value;
};

export const databaseError = (error: unknown): unknown => {
	if (error instanceof Prisma.PrismaClientValidationError)
		return Object.assign(new Error('Database query validation failed'), {
			code: 'PRISMA_VALIDATION'
		});
	if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return error;
	const driver = error.meta?.driverAdapterError as
		{ cause?: { originalCode?: string; constraint?: { index?: string } } } | undefined;
	const nativeCode = String(error.meta?.code || driver?.cause?.originalCode || '');
	if (error.code === 'P2034' || nativeCode === '1213')
		return Object.assign(new Error('Database transaction deadlock'), {
			code: 'ER_LOCK_DEADLOCK',
			errno: 1213
		});
	if (error.code === 'P2002' || nativeCode === '1062') {
		const target = error.meta?.target;
		const index =
			typeof target === 'string' ? target : Array.isArray(target) ? target.join(',') : '';
		const rawIndex =
			driver?.cause?.constraint?.index ||
			/for key ['`]([^'`]+)['`]/i.exec(String(error.meta?.message || ''))?.[1] ||
			'';
		return Object.assign(new Error(`Database unique constraint conflict: ${index || rawIndex}`), {
			code: 'ER_DUP_ENTRY',
			errno: 1062
		});
	}
	// Do not log Prisma's formatted call arguments (they can contain password hashes).
	return Object.assign(new Error(`Database request failed (${error.code})`), {
		code: error.code,
		databaseCode: nativeCode || undefined
	});
};

/** A custom SqlQuery remains a supported test/adapter boundary; real transactions use their own tx. */
export const ormQuery = async <T>(
	query: SqlQuery,
	operation: (client: OrmClient) => Promise<unknown>,
	fallback: () => Promise<T>
): Promise<T> => {
	const client = executors.get(query);
	if (!client) return fallback();
	assertSafeTestDatabaseConfiguration();
	try {
		return normalizeDatabaseValue(await operation(client)) as T;
	} catch (error) {
		throw databaseError(error);
	}
};

export const disconnectPrisma = (): Promise<void> => prisma.$disconnect();
