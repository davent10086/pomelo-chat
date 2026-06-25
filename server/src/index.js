/* global process */

/**
 * 定义全局登录用户房间
 */
global.LoginRooms = {};

/**
 * 引入 app 并启动服务
 * H8: 统一为单一 server，确保 wsOptions 生效
 */
const http = require('http');
const expressWs = require('express-ws');
const app = require('./controller/app');
const port = process.env.PORT || 3000;

// 创建单一 HTTP server，WebSocket 与 HTTP 共用
const server = http.createServer(app);
// 初始化 express-ws，设置最大传输文件大小 5G
expressWs(app, server, { wsOptions: { maxPayload: 5 * 1024 * 1024 * 1024 } });

server.listen(port, '0.0.0.0', () => {
	// eslint-disable-next-line no-console
	console.log(`Server listening on http://0.0.0.0:${port}`);
});

module.exports = { app, server };
