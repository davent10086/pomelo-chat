/** Local convenience runner: creates and drops only its own unmistakably named test DB. */
const path = require('node:path');
const { spawn } = require('node:child_process');
const mysql = require('mysql2');
const fs = require('node:fs');
const Redis = require('ioredis');
const mode = process.argv[2] || 'system';
if (!['system', 'browser', 'migrations', 'backend', 'qa', 'overload', 'realtime', 'ops'].includes(mode))
	throw new Error('Expected system, browser, migrations, backend, qa, overload, realtime, or ops');
const root = path.resolve(__dirname, '../..');
const serverRoot = path.join(root, 'server');
require('dotenv').config({ path: path.join(serverRoot, '.env'), quiet: true });
const configuration = {
	host: process.env.DB_HOST || '127.0.0.1',
	port: Number(process.env.DB_PORT || 3306),
	user: process.env.DB_USER || 'root',
	password: process.env.DB_PASSWORD || ''
};
const database = `pomelo_${mode}_test_${Date.now()}`;
const redisPrefix = `${database}:`;
const testFilesRoot = path.join(root, 'tmp', 'tests');
fs.mkdirSync(testFilesRoot, { recursive: true });
const uploadRoot = fs.mkdtempSync(path.join(testFilesRoot, 'chat-uploads-'));
const connection = mysql.createConnection(configuration);
connection.query('CREATE DATABASE ??', [database], error => {
	if (error) {
		console.error('[isolated-tests] create failed:', error.code);
		connection.end();
		fs.rmSync(uploadRoot, { recursive: true, force: true });
		process.exitCode = 1;
		return;
	}
	const url = new URL('mysql://localhost');
	url.hostname = configuration.host;
	url.port = String(configuration.port);
	url.username = configuration.user;
	url.password = configuration.password;
	url.pathname = '/' + database;
	const args =
		mode === 'browser'
			? [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', ...process.argv.slice(3)]
			: mode === 'qa' ? [path.join(root, 'qa/run-qa.js')] : [
					path.join(
						__dirname,
						mode === 'ops' ? 'test-ops-recovery.js' : mode === 'realtime' ? 'test-go-realtime.js' : mode === 'migrations' ? 'test-db-migrations.js' : mode === 'backend' ? 'test-backend-reliability.js' : mode === 'overload' ? 'test-message-overload.js' : 'test-system-integrity.js'
					),
					...(mode === 'realtime' ? process.argv.slice(3) : [])
				];
	const child = spawn(process.execPath, args, {
		cwd: mode === 'browser' || mode === 'qa' ? root : serverRoot,
		env: {
			...process.env,
			NODE_ENV: 'test',
			REALTIME_DRIVER: 'node',
			OUTBOX_DRIVER: 'node',
			DATABASE_URL_TEST: url.toString(),
			REDIS_URL_TEST: process.env.REDIS_URL_TEST || 'redis://127.0.0.1:6379/15',
			TEST_REDIS_KEY_PREFIX: redisPrefix,
			TEST_RTC: process.env.TEST_RTC || (process.argv.slice(3).includes('real-rtc.e2e.spec.ts') ? '1' : '0'),
			...(['browser', 'realtime', 'ops'].includes(mode) ? { UPLOAD_ROOT: uploadRoot } : {}),
			TS_NODE_FILES: 'true'
		},
		stdio: 'inherit'
	});
	child.on('exit', async (code, signal) => {
		if (signal || code === null) code = 1;
		// Only browser services use this per-run prefix; never flush a Redis database.
		if (['browser', 'realtime'].includes(mode)) {
			const redis = new Redis(process.env.REDIS_URL_TEST || 'redis://127.0.0.1:6379/15', { retryStrategy: () => null });
			try {
				let cursor = '0';
				do {
					const result = await redis.scan(cursor, 'MATCH', `${redisPrefix}*`, 'COUNT', 100);
					cursor = result[0];
					if (result[1].length) await redis.del(...result[1]);
				} while (cursor !== '0');
			} catch (error) {
				console.error('[isolated-tests] Redis cleanup failed:', error.message);
				code = code || 1;
			} finally { redis.disconnect(); }
		}
		if (path.dirname(uploadRoot) !== testFilesRoot || !path.basename(uploadRoot).startsWith('chat-uploads-'))
			throw new Error('Unsafe upload cleanup target');
		fs.rmSync(uploadRoot, { recursive: true, force: true });
		if (!/^pomelo_(system|browser|migrations|backend|qa|overload|realtime|ops)_test_\d+$/.test(database))
			throw new Error('Unsafe cleanup target');
		connection.query('DROP DATABASE ??', [database], err => {
			if (err) console.error('[isolated-tests] cleanup failed:', err.code);
			connection.end();
			process.exitCode = err ? 1 : code || 0;
		});
	});
});
