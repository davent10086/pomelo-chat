/**
 * 用于启动 node 服务并处理相关路由
 */
const express = require('express');
const expressWs = require('express-ws');
const app = express();
expressWs(app);

// CORS 白名单域名（生产环境应通过环境变量配置）
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
	.split(',')
	.map(s => s.trim())
	.filter(Boolean);

/**
 * 解决跨域：使用具体 Origin 回显，配合 Credentials
 */
const cors = (req, res, next) => {
	const origin = req.headers.origin;
	if (origin && ALLOWED_ORIGINS.includes(origin)) {
		res.header('Access-Control-Allow-Origin', origin);
		res.header('Access-Control-Allow-Credentials', 'true');
		// Vary 头便于缓存正确处理不同 Origin
		res.header('Vary', 'Origin');
	}
	// 允许的 header 类型（具体列出，避免 *）
	res.header(
		'Access-Control-Allow-Headers',
		'Content-Type, Authorization, X-Requested-With'
	);
	res.header('Access-Control-Allow-Methods', 'PUT,POST,GET,DELETE,OPTIONS');
	res.header('Content-Type', 'application/json;charset=utf-8');

	if (req.method.toLowerCase() === 'options') {
		res.sendStatus(200);
	} else {
		next();
	}
};

/**
 * 静态文件访问的中间件，利用 Express 托管静态文件
 * L3: 移除强制 octet-stream，让 express.static 根据扩展名自动设置 content-type
 */
const staticDownload = (req, res, next) => {
	const origin = req.headers.origin;
	if (origin && ALLOWED_ORIGINS.includes(origin)) {
		res.header('Access-Control-Allow-Origin', origin);
		res.header('Access-Control-Allow-Credentials', 'true');
		res.header('Vary', 'Origin');
	}
	res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
	res.header('Access-Control-Allow-Methods', 'PUT, POST, GET, DELETE, OPTIONS, HEAD');
	if (req.method.toLowerCase() === 'options') {
		res.sendStatus(200);
	} else {
		next();
	}
};
app.use('/uploads', staticDownload, express.static('uploads'));

/**
 * 处理 HTTP 请求体中的参数
 */
const bodyParser = require('body-parser');
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ limit: '100mb', extended: true }));

/**
 * 注册路由
 */
const indexRouter = require('./routes/auth')();
const friendRouter = require('./routes/friend')();
const messageRouter = require('./routes/message')();
const groupRouter = require('./routes/group')();
const rtcRouter = require('./routes/rtc')();
const fileRouter = require('./routes/file')();
// assistant 代理路由（H4/M10）
const assistantRouter = require('./routes/assistant')();
app.use('', cors);
app.use('/api/chat/v1/auth', cors, indexRouter);
app.use('/api/chat/v1/friend', cors, friendRouter);
app.use('/api/chat/v1/message', cors, messageRouter);
app.use('/api/chat/v1/group', cors, groupRouter);
app.use('/api/chat/v1/rtc', cors, rtcRouter);
app.use('/api/chat/v1/file', cors, fileRouter);
app.use('/api/chat/v1/assistant', cors, assistantRouter);
module.exports = app;
