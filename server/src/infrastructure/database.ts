import * as mysql from 'mysql2';
import { databaseSettings, assertSafeTestDatabaseConfiguration } from './database-config';
export { assertTestDatabaseTarget } from './database-config';
import { initializeDatabase } from './database/migrations';
import { disconnectPrisma } from './prisma';

/**
 * 2. 建立与 MySQL 数据库的连接关系
 * H7: 关闭 multipleStatements 以防 SQL 注入堆叠执行
 */
const db = mysql.createPool({
	...databaseSettings,
	multipleStatements: false, // 关闭：防止 SQL 注入时堆叠执行破坏性语句
	charset: 'utf8mb4',
	connectionLimit: 10
});

export const initDatabase = (): Promise<void> =>
	initializeDatabase(db, assertSafeTestDatabaseConfiguration);

/**
 * 4、测试 mysql 模块能否正常工作
 */
export const assertDatabaseConnection = (): Promise<void> =>
	new Promise((resolve, reject) => {
		try {
			assertSafeTestDatabaseConfiguration();
		} catch (error) {
			reject(error);
			return;
		}
		db.query('select 1', error => (error ? reject(error) : resolve()));
	});

/**
 * 5、将连接好的数据库对象向外导出, 供外界使用
 */
export default db;

export const closeDatabase = async (): Promise<void> => {
	const results = await Promise.allSettled([
		disconnectPrisma(),
		new Promise<void>((resolve, reject) => db.end(error => (error ? reject(error) : resolve())))
	]);
	const failure = results.find(
		(result): result is PromiseRejectedResult => result.status === 'rejected'
	);
	if (failure) throw failure.reason;
};
