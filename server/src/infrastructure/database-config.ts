import * as fs from 'fs';
import * as path from 'path';
import { boundedInteger } from '../shared/validation';
import { DATABASE_TIME_ZONE } from '../shared/time';

/**
 * 1、读取 MySQL 数据库配置
 * 优先级：环境变量 > config.json > 默认值
 * H7: 关闭 multipleStatements，默认密码改为空（强制走配置）
 * L4: 配置读取加 try/catch 保护
 */
let host = process.env.DB_HOST || '127.0.0.1';
let port = boundedInteger('DB_PORT', 3306, 1, 65535);
let user = process.env.DB_USER || 'root';
let password = process.env.DB_PASSWORD || '';
let database = process.env.DB_NAME || 'pomelo-chat';
const testDatabaseUrl = process.env.DATABASE_URL_TEST || process.env.TEST_DATABASE_URL;
const connectionUrl = testDatabaseUrl || process.env.DATABASE_URL;
let ssl: { rejectUnauthorized: boolean } | undefined;
let connectionLimit = 10;

/** Test databases must be unmistakably named so an accidental test run cannot write production data. */
export const assertTestDatabaseTarget = (databaseName: string): void => {
	if (!/(^|[_-])test([_-]|$)|[_-]test$/i.test(databaseName)) {
		throw new Error(
			`Refusing to run tests against non-test database: ${databaseName}. Configure DATABASE_URL_TEST.`
		);
	}
};

if (connectionUrl) {
	try {
		const parsed = new URL(connectionUrl);
		if (parsed.protocol !== 'mysql:') throw new Error('Expected mysql URL');
		if (parsed.hash || parsed.pathname.length < 2) throw new Error('Expected a database name');
		for (const key of parsed.searchParams.keys()) if (!['ssl-mode', 'connection_limit'].includes(key)) throw new Error('Unsupported URL option');
		const sslMode = parsed.searchParams.get('ssl-mode');
		if (sslMode && !['REQUIRED', 'VERIFY_IDENTITY'].includes(sslMode)) throw new Error('Unsupported TLS mode');
		if (sslMode) ssl = { rejectUnauthorized: true };
		const limit = parsed.searchParams.get('connection_limit');
		if (limit !== null) {
			if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error('Invalid connection_limit');
			connectionLimit = Number(limit);
		}
		host = parsed.hostname;
		port = Number(parsed.port || 3306);
		user = decodeURIComponent(parsed.username);
		password = decodeURIComponent(parsed.password);
		database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
	} catch {
		throw new Error(
			'Database URL must be mysql:// with a database name; supported options: ssl-mode=REQUIRED|VERIFY_IDENTITY, connection_limit=1..100'
		);
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
		if (!process.env.DB_HOST && !connectionUrl) host = res.host || host;
		if (!process.env.DB_PORT && !connectionUrl) port = res.port || port;
		if (!process.env.DB_USER && !connectionUrl) user = res.user || user;
		if (!process.env.DB_PASSWORD && !connectionUrl) password = res.password || password;
		if (!process.env.DB_NAME && !connectionUrl) database = res.database || database;
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		// eslint-disable-next-line no-console
		console.error('[db] 读取 config.json 失败，使用默认/环境变量配置:', err.message);
	}
}

if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !host || !user || !database) throw new Error('Invalid database configuration');
if (process.env.NODE_ENV === 'production' && !connectionUrl && (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME || process.env.DB_PASSWORD === undefined))
	throw new Error('Production requires DATABASE_URL or explicit DB_HOST/DB_USER/DB_PASSWORD/DB_NAME');
export const databaseSettings = { host, port, user, password, database, ssl, connectionLimit, timezone: DATABASE_TIME_ZONE };
export const databaseUrl = (() => {
	const url = new URL('mysql://localhost');
	url.hostname = host;
	url.port = String(port);
	url.username = user;
	url.password = password;
	url.pathname = '/' + database;
	return url.toString();
})();
export const assertSafeTestDatabaseConfiguration = (): void => {
	if (process.env.NODE_ENV !== 'test' && process.env.APP_ENV !== 'test') return;
	if (!testDatabaseUrl)
		throw new Error(
			'DATABASE_URL_TEST (or TEST_DATABASE_URL) is required when running database tests'
		);
	assertTestDatabaseTarget(database);
};
