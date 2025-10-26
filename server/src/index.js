/* global process */

/**
 * 定义全局登录用户房间
 */
global.LoginRooms = {};

/**
 * 引入 app 并启动服务
 */
const expressWs = require('express-ws');
const app = require('./controller/app');
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
	// eslint-disable-next-line no-console
	console.log(`Server listening on http://0.0.0.0:${port}`);
});

/**
 * 设置最大传输文件大小 5G
 */
const http = require('http');
const server = http.createServer(app);
// 初始化 express-ws 的 ws 限制（注意：app.listen 已经创建了内部 server，这里仅保留 ws 配置方便后续扩展）
expressWs(app, server, { wsOptions: { maxPayload: 5 * 1024 * 1024 * 1024 } });
