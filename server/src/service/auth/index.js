/* global LoginRooms */
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { AuthStatus, CommonStatus } = require('../../utils/status');
const { RespData, RespSuccess, RespError } = require('../../utils/resp');
const { secretKey, better_chat, verifyToken } = require('../../utils/authenticate');
const { NotificationUser } = require('../../utils/notification');
const { Query } = require('../../utils/query');

// bcrypt 计算 cost
const BCRYPT_SALT_ROUNDS = 10;
// JWT 过期时间
const JWT_EXPIRES_IN = '7d';

// 构造精简的 JWT payload（不含 password/salt 等敏感字段）
const buildPayload = (user) => ({
	id: user.id,
	avatar: user.avatar,
	username: user.username,
	name: user.name,
	phone: user.phone
});

// 构造返回给前端的 info（不含 password/salt）
const buildInfo = (user) => ({
	id: user.id,
	avatar: user.avatar,
	username: user.username,
	name: user.name,
	phone: user.phone,
	created_at: new Date(user.created_at)
		.toLocaleString('zh-CN', { hour12: false })
		.replace(/\//g, '-'),
	signature: user.signature
});

// 签发 JWT 并写入 Redis 白名单
const issueToken = async (user) => {
	const payload = buildPayload(user);
	const token = jwt.sign(payload, secretKey, { expiresIn: JWT_EXPIRES_IN });
	await better_chat.set(`token:${payload.username}`, token, 'EX', 60 * 60 * 24 * 14); // 14 天
	return token;
};

/**
 * 用户登录处理函数
 * 兼容旧 MD5 哈希用户：登录成功后自动升级为 bcrypt
 */
const login = async (req, res) => {
	const { username, password } = req.body;
	if (!(username && password)) {
		return RespError(res, CommonStatus.PARAM_ERR);
	}
	try {
		const sql = `SELECT * FROM user WHERE username = ?`;
		const results = await Query(sql, [username]);
		if (results.length === 0) {
			return RespError(res, AuthStatus.USER_OR_PASS_ERR);
		}
		const user = results[0];
		// 校验密码：兼容 bcrypt 与旧 MD5
		let passwordOk = false;
		let needUpgrade = false;
		if (user.password && user.password.startsWith('$2')) {
			// 新 bcrypt 哈希
			passwordOk = await bcrypt.compare(password, user.password);
		} else {
			// 旧 MD5 + 短 salt
			const M = user.salt.slice(0, 3) + password + user.salt.slice(3);
			const crypto = require('crypto');
			const hash = crypto.createHash('md5').update(M).digest('hex');
			passwordOk = hash === user.password;
			needUpgrade = passwordOk;
		}
		if (!passwordOk) {
			return RespError(res, AuthStatus.USER_OR_PASS_ERR);
		}
		// 升级旧 MD5 哈希为 bcrypt
		if (needUpgrade) {
			const newHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
			await Query(`UPDATE user SET password = ? WHERE id = ?`, [newHash, user.id]);
		}
		// 检查 Redis 是否已登录（单点登录控制）
		const redisToken = await better_chat.get(`token:${username}`);
		if (redisToken) {
			return RespError(res, AuthStatus.USER_ALREADY_LOGGEDIN);
		}
		// 签发 token
		const token = await issueToken(user);
		// 更新好友在线状态
		const sqlUpdate = `UPDATE friend SET online_status = ? WHERE username = ?`;
		await Query(sqlUpdate, ['online', username]);
		return RespData(res, { token, info: buildInfo(user) });
	} catch (err) {
		console.error('[auth] login 异常:', err.message);
		return RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 用户登出处理函数：删除 Redis 中的 token 实现真正失效
 */
const logout = async (req, res) => {
	const { username } = req.body;
	if (!username) {
		return RespError(res, CommonStatus.PARAM_ERR);
	}
	try {
		const sql = `UPDATE friend SET online_status = ? WHERE username = ?`;
		await Query(sql, ['offline', username]);
		await better_chat.del(`token:${username}`);
		return RespSuccess(res);
	} catch (err) {
		console.error('[auth] logout 异常:', err.message);
		return RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 用户注册处理函数：使用 bcrypt 哈希密码
 */
const register = async (req, res) => {
	const { username, password, phone, avatar } = req.body;
	if (!(username && password && phone)) {
		return RespError(res, CommonStatus.PARAM_ERR);
	}
	try {
		const sql_check = `SELECT username, phone FROM user WHERE username = ? OR phone = ?`;
		const results_check = await Query(sql_check, [username, phone]);
		if (results_check.length !== 0) {
			return RespError(res, AuthStatus.USER_EXIT_ERR);
		}
		// bcrypt 哈希（自带随机 salt，无需单独存储）
		const hash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
		const user = {
			avatar,
			username,
			password: hash,
			name: username,
			phone,
			signature: '',
			salt: '' // 保留字段以兼容旧表结构，bcrypt 不需要
		};
		const sql_set_user = `INSERT INTO user SET ?`;
		const results_set_user = await Query(sql_set_user, user);
		if (results_set_user.affectedRows === 1) {
			const sql_get_user = `SELECT * FROM user WHERE username = ?`;
			const results_get_user = await Query(sql_get_user, [username]);
			const info = results_get_user[0];
			// 创建默认分组
			const friend_group = { user_id: info.id, username, name: '我的好友' };
			await Query(`INSERT INTO friend_group SET ?`, friend_group);
			const token = await issueToken(info);
			return RespData(res, { token, info: buildInfo(info) });
		}
	} catch (err) {
		console.error('[auth] register 异常:', err.message);
		return RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 忘记密码/修改密码：使用 bcrypt 重置
 */
const forgetPassword = async (req, res) => {
	const { username, phone, password } = req.body;
	if (!(username && phone && password)) {
		return RespError(res, CommonStatus.PARAM_ERR);
	}
	try {
		const sql_check = `SELECT id FROM user WHERE username = ? AND phone = ?`;
		const results_check = await Query(sql_check, [username, phone]);
		if (results_check.length === 0) {
			return RespError(res, AuthStatus.USER_NOTEXIT_ERR);
		}
		const hash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
		const sql_set = `UPDATE user SET password = ?, salt = '' WHERE username = ?`;
		const results_set = await Query(sql_set, [hash, username]);
		if (results_set.affectedRows === 1) {
			return RespSuccess(res);
		}
	} catch (err) {
		console.error('[auth] forgetPassword 异常:', err.message);
		return RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 更新用户信息：签发新 token（精简 payload）
 */
const updateInfo = async (req, res) => {
	const { username, avatar, name, phone, signature } = req.body;
	if (!username) {
		return RespError(res, CommonStatus.PARAM_ERR);
	}
	try {
		const sql_check = `SELECT * FROM user WHERE phone = ?`;
		const results_check = await Query(sql_check, [phone]);
		if (results_check.length !== 0 && results_check[0].username !== username) {
			return RespError(res, AuthStatus.PHONE_EXIT_ERR);
		}
		const info = { avatar, name, phone, signature };
		const sql_set = `UPDATE user SET ? WHERE username = ?`;
		const results_set = await Query(sql_set, [info, username]);
		if (results_set.affectedRows === 1) {
			const sql_get = `SELECT * FROM user WHERE username = ?`;
			const results_get = await Query(sql_get, [username]);
			const user = results_get[0];
			const token = await issueToken(user);
			return RespData(res, { token, info: buildInfo(user) });
		}
	} catch (err) {
		console.error('[auth] updateInfo 异常:', err.message);
		return RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 初始化用户通知管道(websocket连接)
 * H3: 增加 token 认证，防止身份冒充
 */
const initUserNotification = async (ws, req) => {
	const url = req.url.split('?')[1];
	const params = new URLSearchParams(url);
	const curUsername = params.get('username');
	const token = params.get('token');
	// 校验 token
	const decoded = verifyToken(token);
	if (!decoded || decoded.username !== curUsername) {
		ws.send(JSON.stringify({ name: 'error', message: '认证失败' }));
		ws.close(4001, 'unauthorized');
		return;
	}
	LoginRooms[curUsername] = {
		ws: ws,
		status: false
	};
	for (const username in LoginRooms) {
		if (username === curUsername) continue;
		NotificationUser({ receiver_username: username, name: 'friendList' });
	}
	ws.on('close', () => {
		if (LoginRooms[curUsername]) {
			delete LoginRooms[curUsername];
			for (const username in LoginRooms) {
				NotificationUser({ receiver_username: username, name: 'friendList' });
			}
		}
	});

	ws.on('error', err => {
		console.error(`[通知管道] 连接出错 username=${curUsername}:`, err.message);
	});
};

module.exports = {
	login,
	logout,
	register,
	forgetPassword,
	updateInfo,
	initUserNotification
};
