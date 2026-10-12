/** Local convenience runner: creates and drops only its own unmistakably named test DB. */
const path = require('node:path');
const { spawn } = require('node:child_process');
const mysql = require('mysql2');
const mode = process.argv[2] || 'system';
if (!['system', 'browser', 'migrations'].includes(mode))
	throw new Error('Expected system, browser, or migrations');
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
const connection = mysql.createConnection(configuration);
connection.query('CREATE DATABASE ??', [database], error => {
	if (error) {
		console.error('[isolated-tests] create failed:', error.code);
		connection.end();
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
			? [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test']
			: [
					path.join(
						__dirname,
						mode === 'migrations' ? 'test-db-migrations.js' : 'test-system-integrity.js'
					)
				];
	const child = spawn(process.execPath, args, {
		cwd: mode === 'browser' ? root : serverRoot,
		env: {
			...process.env,
			NODE_ENV: 'test',
			DATABASE_URL_TEST: url.toString(),
			REDIS_URL_TEST: process.env.REDIS_URL_TEST || 'redis://127.0.0.1:6379/15',
			TS_NODE_FILES: 'true'
		},
		stdio: 'inherit'
	});
	child.on('exit', code => {
		if (!/^pomelo_(system|browser|migrations)_test_\d+$/.test(database))
			throw new Error('Unsafe cleanup target');
		connection.query('DROP DATABASE ??', [database], err => {
			if (err) console.error('[isolated-tests] cleanup failed:', err.code);
			connection.end();
			process.exitCode = code || 0;
		});
	});
});
