import * as mysql from 'mysql2';
import * as fs from 'fs';
import * as path from 'path';
import { initializeDatabase } from './database/migrations';

/**
 * 1、读取 MySQL 数据库配置
 * 优先级：环境变量 > config.json > 默认值
 * H7: 关闭 multipleStatements，默认密码改为空（强制走配置）
 * L4: 配置读取加 try/catch 保护
 */
let host = process.env.DB_HOST || '127.0.0.1';
let port = parseInt(process.env.DB_PORT || '3306', 10);
let user = process.env.DB_USER || 'root';
let password = process.env.DB_PASSWORD || '';
let database = process.env.DB_NAME || 'pomelo-chat';
const testDatabaseUrl = process.env.DATABASE_URL_TEST || process.env.TEST_DATABASE_URL;

/** Test databases must be unmistakably named so an accidental test run cannot write production data. */
export const assertTestDatabaseTarget = (databaseName: string): void => {
	if (!/(^|[_-])test([_-]|$)|[_-]test$/i.test(databaseName)) {
		throw new Error(
			`Refusing to run tests against non-test database: ${databaseName}. Configure DATABASE_URL_TEST.`
		);
	}
};

if (testDatabaseUrl) {
	try {
		const parsed = new URL(testDatabaseUrl);
		host = parsed.hostname;
		port = Number(parsed.port || 3306);
		user = decodeURIComponent(parsed.username);
		password = decodeURIComponent(parsed.password);
		database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
	} catch {
		throw new Error('DATABASE_URL_TEST must be a valid MySQL connection URL');
	}
}

const configPaths = [
	path.join(process.cwd(), './config.json'),
	path.join(__dirname, '../model/config.json')
];
const configPath = configPaths.find(item => fs.existsSync(item));
if (configPath) {
	try {
		const res = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
		// 仅在环境变量未设置时使用配置文件的值
		if (!process.env.DB_HOST && !testDatabaseUrl) host = res.host || host;
		if (!process.env.DB_PORT && !testDatabaseUrl) port = res.port || port;
		if (!process.env.DB_USER && !testDatabaseUrl) user = res.user || user;
		if (!process.env.DB_PASSWORD && !testDatabaseUrl) password = res.password || password;
		if (!process.env.DB_NAME && !testDatabaseUrl) database = res.database || database;
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		// eslint-disable-next-line no-console
		console.error('[db] 读取 config.json 失败，使用默认/环境变量配置:', err.message);
	}
}

/**
 * 2. 建立与 MySQL 数据库的连接关系
 * H7: 关闭 multipleStatements 以防 SQL 注入堆叠执行
 */
const db = mysql.createPool({
	host,
	port,
	user,
	password,
	database,
	multipleStatements: false, // 关闭：防止 SQL 注入时堆叠执行破坏性语句
	charset: 'utf8mb4',
	connectionLimit: 10
});

const assertSafeTestDatabaseConfiguration = (): void => {
	if (process.env.NODE_ENV !== 'test' && process.env.APP_ENV !== 'test') return;
	if (!testDatabaseUrl)
		throw new Error(
			'DATABASE_URL_TEST (or TEST_DATABASE_URL) is required when running database tests'
		);
	assertTestDatabaseTarget(database);
};

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
