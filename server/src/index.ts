/**
 * 定义全局登录用户房间
 */
import 'dotenv/config';
import http from 'http';
import expressWs from 'express-ws';
import app, { registerAppRoutes } from './controller/app';
import { assertDatabaseConnection, initDatabase } from './model/db';

// 全局登录用户房间
global.LoginRooms = {};

const port = Number(process.env.PORT || 3000);

// 创建单一 HTTP server，WebSocket 与 HTTP 共用
const server = http.createServer(app);
// 初始化 express-ws，设置最大传输文件大小 5G
// H8: 统一为单一 server，确保 wsOptions 生效
expressWs(app, server, { wsOptions: { maxPayload: 1024 * 1024 } });
registerAppRoutes();

const startServer = async (): Promise<void> => {
	await assertDatabaseConnection();
	// eslint-disable-next-line no-console
	console.log('MySQL 连接成功');
	await initDatabase();
	server.listen(port, '0.0.0.0', () => {
		// eslint-disable-next-line no-console
		console.log(`Server listening on http://0.0.0.0:${port}`);
	});
};

void startServer().catch((caught: unknown) => {
	const err = caught instanceof Error ? caught : new Error(String(caught));
	// eslint-disable-next-line no-console
	console.error('服务启动失败:', err.message);
	process.exit(1);
});

export { app, server };
