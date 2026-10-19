import * as fs from 'fs';
import * as path from 'path';

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
const connectionUrl = testDatabaseUrl || process.env.DATABASE_URL;

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
		if (parsed.search || parsed.hash || parsed.pathname.length < 2)
			throw new Error('Only basic MySQL URLs with a database name are supported');
		host = parsed.hostname;
		port = Number(parsed.port || 3306);
		user = decodeURIComponent(parsed.username);
		password = decodeURIComponent(parsed.password);
		database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
	} catch {
		throw new Error(
			'Database URL must be a mysql URL with a database name and no query/fragment options'
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

export const databaseSettings = { host, port, user, password, database };
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
