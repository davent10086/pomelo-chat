import * as crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { WebSocket } from 'ws';
import type { Request, Response } from 'express';

import { AuthStatus, CommonStatus } from '../../utils/status';
import { RespData, RespSuccess, RespError } from '../../utils/resp';
import {
	secretKey,
	better_chat,
	verifyTokenWithSession,
	notifySessionChanged,
	extractToken
} from '../../utils/authenticate';
import { NotificationUser } from '../../utils/notification';
import {
	notificationUsers,
	registerNotificationSocket,
	removeNotificationSocket
} from '../../utils/notification-connections';
import { Query, withTransaction } from '../../utils/query';
import { assertOwnedAvatar } from '../../utils/attachments';
import { getCall, transitionCall } from '../rtc/calls';
import { registerSessionSocket, validateSessionSocket } from '../../utils/socket-session';

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
const releaseUserCall = async (username: string): Promise<void> => {
	const id = await better_chat.get(`rtc:busy:${username}`);
	if (id && (await getCall(id))) await transitionCall(id, username, 'leave');
};

const issueToken = async (user: UserRow, endPreviousCall = false): Promise<string> => {
	if (endPreviousCall) await releaseUserCall(user.username);
	const payload = buildPayload(user);
	const token = jwt.sign(payload, secretKey as jwt.Secret, {
		expiresIn: JWT_EXPIRES_IN,
		jwtid: crypto.randomUUID()
	});
	await better_chat.set(`token:${payload.username}`, token, 'EX', 60 * 60 * 24 * 14); // 14 天
	await notifySessionChanged(payload.username, token);
	return token;
};

/**
 * 用户登录处理函数
 * 兼容旧 MD5 哈希用户：登录成功后自动升级为 bcrypt
 */
export const login = async (req: Request, res: Response): Promise<void> => {
	const { username, password } = req.body || {};
	if (
		typeof username !== 'string' ||
		!username.trim() ||
		typeof password !== 'string' ||
		!password ||
		Buffer.byteLength(password) > 72
	) {
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
		const token = await issueToken(user, true);
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
		await better_chat.eval(
			"if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
			1,
			`token:${username}`,
			extractToken(req.headers.authorization) || ''
		);
		await notifySessionChanged(username);
		await releaseUserCall(username);
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
	if (
		typeof username !== 'string' ||
		!username.trim() ||
		username.length > 50 ||
		typeof password !== 'string' ||
		!password ||
		Buffer.byteLength(password) > 72 ||
		typeof phone !== 'string' ||
		!/^1[3-9]\d{9}$/.test(phone) ||
		(typeof avatar === 'string' && avatar.startsWith('/uploads'))
	) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		await assertOwnedAvatar(0, avatar);
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
		const info = await withTransaction(async query => {
			const result = await query<{ insertId: number }>('INSERT INTO user SET ?', user);
			await query('INSERT INTO friend_group SET ?', {
				user_id: result.insertId,
				username,
				name: '我的好友'
			});
			const rows = await query<UserRow[]>('SELECT * FROM user WHERE id = ?', [result.insertId]);
			return rows[0];
		});
		RespData(res, { info: buildInfo(info) });
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
	if (
		!(userId && currentPassword && password) ||
		typeof currentPassword !== 'string' ||
		typeof password !== 'string' ||
		Buffer.byteLength(password) > 72
	) {
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
			await notifySessionChanged(req.user!.username);
			await releaseUserCall(req.user!.username);
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
		await assertOwnedAvatar(req.user!.id, avatar);
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
	try {
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
		registerSessionSocket(ws, curUsername, token, verifyTokenWithSession);
		const presenceLease = crypto.randomUUID();
		await better_chat.set(`presence:${curUsername}`, presenceLease, 'EX', 30);
		let present = true;
		const heartbeat = setInterval(() => {
			void validateSessionSocket(ws)
				.then(valid =>
					valid && present && ws.readyState === 1
						? better_chat.set(`presence:${curUsername}`, presenceLease, 'EX', 30)
						: undefined
				)
				.catch(err => console.error('[auth] presence:', err));
		}, 15000);
		heartbeat.unref();
		const cleanupPresence = async () => {
			present = false;
			clearInterval(heartbeat);
			const removed = await better_chat
				.eval(
					"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
					1,
					`presence:${curUsername}`,
					presenceLease
				)
				.catch(err => console.error('[auth] presence cleanup:', err));
			if (removed === 1)
				await Query('UPDATE friend SET online_status = ? WHERE username = ?', [
					'offline',
					curUsername
				]).catch(err => console.error('[auth] offline update:', err));
		};
		if (ws.readyState !== 1) {
			await cleanupPresence();
			return;
		}
		registerNotificationSocket(curUsername, ws, cleanupPresence);
		for (const username of notificationUsers()) {
			if (username === curUsername) continue;
			void NotificationUser({ receiver_username: username, name: 'friendList' }).catch(err =>
				console.error('[auth] notification:', err)
			);
		}

		ws.on('close', () => {
			if (removeNotificationSocket(curUsername, ws)) {
				for (const username of notificationUsers()) {
					void NotificationUser({ receiver_username: username, name: 'friendList' }).catch(err =>
						console.error('[auth] notification:', err)
					);
				}
			}
		});

		ws.on('error', (err: Error) => {
			console.error(`[通知管道] 连接出错 username=${curUsername}:`, err.message);
		});
		await Query('UPDATE friend SET online_status = ? WHERE username = ?', ['online', curUsername]);
	} catch (err) {
		console.error('[auth] notification channel failed:', err);
		ws.close(4001, 'notification channel unavailable');
	}
};
