/**
 * 定义全局登录用户房间
 */
import 'dotenv/config';
import http from 'http';
import expressWs from 'express-ws';
import app, { registerAppRoutes } from './controller/app';

// 全局登录用户房间
global.LoginRooms = {};

const port = Number(process.env.PORT || 3000);

// 创建单一 HTTP server，WebSocket 与 HTTP 共用
const server = http.createServer(app);
// 初始化 express-ws，设置最大传输文件大小 5G
// H8: 统一为单一 server，确保 wsOptions 生效
expressWs(app, server, { wsOptions: { maxPayload: 1024 * 1024 } });
registerAppRoutes();

server.listen(port, '0.0.0.0', () => {
	// eslint-disable-next-line no-console
	console.log(`Server listening on http://0.0.0.0:${port}`);
});

export { app, server };
