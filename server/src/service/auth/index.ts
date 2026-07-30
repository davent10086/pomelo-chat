import * as crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { WebSocket } from 'ws';
import type { Request, Response } from 'express';

import { AuthStatus, CommonStatus } from '../../utils/status';
import { RespData, RespSuccess, RespError } from '../../utils/resp';
import { secretKey, better_chat, verifyTokenWithSession } from '../../utils/authenticate';
import { NotificationUser } from '../../utils/notification';
import { Query } from '../../utils/query';

// bcrypt 计算 cost
const BCRYPT_SALT_ROUNDS = 10;
// JWT 过期时间
const JWT_EXPIRES_IN = '7d';

interface UserRow {
	id: number;
	avatar?: string;
	username: string;
	name?: string;
	phone: string;
	password?: string;
	salt?: string;
	signature?: string;
	created_at?: string | Date;
	[key: string]: unknown;
}

interface WriteResult {
	affectedRows: number;
}

interface ExistingUserRow {
	id: number;
	username: string;
	phone: string;
}

// 构造精简的 JWT payload（不含 password/salt 等敏感字段）
const buildPayload = (user: UserRow) => ({
	id: user.id,
	avatar: user.avatar,
	username: user.username,
	name: user.name,
	phone: user.phone
});

// 构造返回给前端的 info（不含 password/salt）
const buildInfo = (user: UserRow) => ({
	id: user.id,
	avatar: user.avatar,
	username: user.username,
	name: user.name,
	phone: user.phone,
	created_at: new Date(user.created_at ?? 0)
		.toLocaleString('zh-CN', { hour12: false })
		.replace(/\//g, '-'),
	signature: user.signature
});

// 签发 JWT 并写入 Redis 白名单
const issueToken = async (user: UserRow): Promise<string> => {
	const payload = buildPayload(user);
	const token = jwt.sign(payload, secretKey as jwt.Secret, { expiresIn: JWT_EXPIRES_IN });
	await better_chat.set(`token:${payload.username}`, token, 'EX', 60 * 60 * 24 * 14); // 14 天
	return token;
};

/**
 * 用户登录处理函数
 * 兼容旧 MD5 哈希用户：登录成功后自动升级为 bcrypt
 */
export const login = async (req: Request, res: Response): Promise<void> => {
	const { username, password } = req.body || {};
	if (!(username && password)) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const sql = `SELECT * FROM user WHERE username = ?`;
		const results = await Query<UserRow[]>(sql, [username]);
		if (results.length === 0) {
			RespError(res, AuthStatus.USER_OR_PASS_ERR);
			return;
		}
		const user: UserRow = results[0];
		// 校验密码：兼容 bcrypt 与旧 MD5
		let passwordOk = false;
		let needUpgrade = false;
		if (user.password && user.password.startsWith('$2')) {
			// 新 bcrypt 哈希
			passwordOk = await bcrypt.compare(password, user.password);
		} else {
			// 旧 MD5 + 短 salt
			const M = (user.salt || '').slice(0, 3) + password + (user.salt || '').slice(3);
			const hash = crypto.createHash('md5').update(M).digest('hex');
			passwordOk = hash === user.password;
			needUpgrade = passwordOk;
		}
		if (!passwordOk) {
			RespError(res, AuthStatus.USER_OR_PASS_ERR);
			return;
		}
		// 升级旧 MD5 哈希为 bcrypt
		if (needUpgrade) {
			const newHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
			await Query(`UPDATE user SET password = ? WHERE id = ?`, [newHash, user.id]);
		}
		// 签发 token。允许重复登录：新 token 会覆盖 Redis 中旧 token，旧会话后续请求自然失效。
		const token = await issueToken(user);
		// 更新好友在线状态
		const sqlUpdate = `UPDATE friend SET online_status = ? WHERE username = ?`;
		await Query(sqlUpdate, ['online', username]);
		RespData(res, { token, info: buildInfo(user) });
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[auth] login 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 用户登出处理函数：删除 Redis 中的 token 实现真正失效
 */
export const logout = async (req: Request, res: Response): Promise<void> => {
	const username = req.user?.username;
	if (!username) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const sql = `UPDATE friend SET online_status = ? WHERE username = ?`;
		await Query(sql, ['offline', username]);
		await better_chat.del(`token:${username}`);
		RespSuccess(res);
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[auth] logout 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 用户注册处理函数：使用 bcrypt 哈希密码
 */
export const register = async (req: Request, res: Response): Promise<void> => {
	const { username, password, phone, avatar } = req.body || {};
	if (!(username && password && phone)) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const sql_check = `SELECT username, phone FROM user WHERE username = ? OR phone = ?`;
		const results_check = await Query<ExistingUserRow[]>(sql_check, [username, phone]);
		if (results_check.length !== 0) {
			RespError(res, AuthStatus.USER_EXIT_ERR);
			return;
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
		const results_set_user = await Query<WriteResult>(sql_set_user, user);
		if (results_set_user.affectedRows === 1) {
			const sql_get_user = `SELECT * FROM user WHERE username = ?`;
			const results_get_user = await Query<UserRow[]>(sql_get_user, [username]);
			const info: UserRow = results_get_user[0];
			// 创建默认分组
			const friend_group = { user_id: info.id, username, name: '我的好友' };
			await Query(`INSERT INTO friend_group SET ?`, friend_group);
			RespData(res, { info: buildInfo(info) });
		}
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[auth] register 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 忘记密码/修改密码：使用 bcrypt 重置
 */
export const forgetPassword = async (req: Request, res: Response): Promise<void> => {
	const { currentPassword, password } = req.body || {};
	const userId = req.user?.id;
	if (!(userId && currentPassword && password) || typeof currentPassword !== 'string' || typeof password !== 'string') {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const sql_check = `SELECT id, password FROM user WHERE id = ?`;
		const results_check = await Query<UserRow[]>(sql_check, [userId]);
		if (results_check.length === 0) {
			RespError(res, AuthStatus.USER_NOTEXIT_ERR);
			return;
		}
		const user = results_check[0] as UserRow;
		if (!user.password || !(await bcrypt.compare(currentPassword, user.password))) {
			RespError(res, AuthStatus.USER_OR_PASS_ERR);
			return;
		}
		const hash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
		const sql_set = `UPDATE user SET password = ?, salt = '' WHERE id = ?`;
		const results_set = await Query<WriteResult>(sql_set, [hash, userId]);
		if (results_set.affectedRows === 1) {
			await better_chat.del(`token:${req.user!.username}`);
			RespSuccess(res);
			return;
		}
		RespError(res, CommonStatus.UPDATE_ERR);
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[auth] forgetPassword 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 更新用户信息：签发新 token（精简 payload）
 */
export const updateInfo = async (req: Request, res: Response): Promise<void> => {
	const { avatar, name, phone, signature } = req.body || {};
	const username = req.user?.username;
	if (!username || !phone) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const sql_check = `SELECT * FROM user WHERE phone = ?`;
		const results_check = await Query<ExistingUserRow[]>(sql_check, [phone]);
		if (results_check.length !== 0 && results_check[0].id !== req.user!.id) {
			RespError(res, AuthStatus.PHONE_EXIT_ERR);
			return;
		}
		const info = { avatar, name, phone, signature };
		const sql_set = `UPDATE user SET ? WHERE username = ?`;
		const results_set = await Query<WriteResult>(sql_set, [info, username]);
		if (results_set.affectedRows === 1) {
			const sql_get = `SELECT * FROM user WHERE username = ?`;
			const results_get = await Query<UserRow[]>(sql_get, [username]);
			const user: UserRow = results_get[0];
			const token = await issueToken(user);
			RespData(res, { token, info: buildInfo(user) });
		}
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[auth] updateInfo 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 初始化用户通知管道(websocket连接)
 * H3: 增加 token 认证，防止身份冒充
 */
export const initUserNotification = async (ws: WebSocket, req: Request): Promise<void> => {
	const url = req.url!.split('?')[1];
	const params = new URLSearchParams(url);
	const curUsername = params.get('username') || '';
	const token = params.get('token') || '';
	// 校验 token
	const decoded = await verifyTokenWithSession(token);
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

	ws.on('error', (err: Error) => {
		console.error(`[通知管道] 连接出错 username=${curUsername}:`, err.message);
	});
};
