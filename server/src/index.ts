/** HTTP entry point owns startup and complete shutdown. */
import 'dotenv/config';
import http from 'http';
import expressWs from 'express-ws';
import app, { registerAppRoutes } from './controller/app';
import { startBackgroundServices, stopBackgroundServices } from './runtime';
import { better_chat } from './utils/authenticate';
import db, { assertDatabaseConnection, initDatabase } from './model/db';

const port = Number(process.env.PORT || 3000);
let stopping = false;

// 创建单一 HTTP server，WebSocket 与 HTTP 共用
const server = http.createServer(app);
// 初始化 express-ws，设置最大传输文件大小 5G
// H8: 统一为单一 server，确保 wsOptions 生效
const realtime = expressWs(app, server, { wsOptions: { maxPayload: 1024 * 1024 } });
registerAppRoutes();

const startServer = async (): Promise<void> => {
	await assertDatabaseConnection();
	// eslint-disable-next-line no-console
	console.log('MySQL 连接成功');
	await initDatabase();
	if (stopping) return;
	await startBackgroundServices();
	if (stopping) return;
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '0.0.0.0', () => {
			server.off('error', reject);
			console.log(`Server listening on http://0.0.0.0:${port}`);
			resolve();
		});
	});
};

const startup = startServer();
void startup.catch((caught: unknown) => {
	const err = caught instanceof Error ? caught : new Error(String(caught));
	// eslint-disable-next-line no-console
	console.error('服务启动失败:', err.message);
	process.exit(1);
});

export { app, server };

server.on('close', () => {
	void stopBackgroundServices().catch(error => console.error('[shutdown:background]', error));
});
let shutdown: Promise<void> | undefined;
export const stopServer = () => {
	stopping = true;
	return (shutdown ||= (async () => {
		await startup.catch(() => undefined);
		const closed = server.listening
			? new Promise<void>((resolve, reject) => {
					server.close(error => (error ? reject(error) : resolve()));
					server.closeAllConnections();
				})
			: Promise.resolve();
		const upgrades = Promise.all(
			[...realtime.getWss().clients].map(
				ws =>
					new Promise<void>(resolve => {
						if (ws.readyState === 3) {
							resolve();
							return;
						}
						const timer = setTimeout(() => {
							ws.terminate();
							resolve();
						}, 1000);
						ws.once('close', () => {
							clearTimeout(timer);
							resolve();
						});
						if (ws.readyState < 2) ws.close(1001, 'server stopping');
					})
			)
		);
		const stopped = await Promise.allSettled([stopBackgroundServices(), upgrades, closed]);
		const dependencies = await Promise.allSettled([
			(async () => {
				if (better_chat.status !== 'wait' && better_chat.status !== 'end') await better_chat.quit();
				else better_chat.disconnect();
			})(),
			new Promise<void>((resolve, reject) => db.end(error => (error ? reject(error) : resolve())))
		]);
		const failures = [...stopped, ...dependencies].filter(
			(result): result is PromiseRejectedResult => result.status === 'rejected'
		);
		if (failures.length)
			throw new Error(
				`Shutdown failed: ${failures.map(result => String(result.reason)).join('; ')}`
			);
	})());
};
for (const signal of ['SIGINT', 'SIGTERM'] as const)
	process.once(signal, () => {
		void stopServer().catch(error => {
			console.error('[shutdown]', error);
			process.exitCode = 1;
		});
	});
