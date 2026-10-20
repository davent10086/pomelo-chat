export interface LoginInput {
	username?: unknown;
	password?: unknown;
}
export interface RegisterInput {
	username?: unknown;
	password?: unknown;
	phone?: unknown;
	avatar?: unknown;
}
export interface ForgetPasswordInput {
	currentPassword?: unknown;
	password?: unknown;
}
export interface UpdateInfoInput {
	avatar?: unknown;
	name?: unknown;
	phone?: unknown;
	signature?: unknown;
}
import * as repository from './repository';
import * as crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { better_chat } from '../../infrastructure/redis';
import { secretKey, extractToken } from './session';
import { AuthStatus, CommonStatus } from '../../shared/status';
import { success, failure, type Outcome } from '../../shared/outcome';
import type { Actor } from '../../shared/actor';
import { withTransaction } from '../../infrastructure/database-query';
import { assertOwnedAvatar } from '../files/public';
import { formatTimestamp } from '../../shared/time';
import { consumeRateLimit } from '../../infrastructure/rate-counter';
import { boundedInteger } from '../../shared/validation';
import { AssistantStatus } from '../../shared/status';
export const createIdentityApplication = (dependencies: {
	releaseUserCall: (username: string) => Promise<void>;
	notifySessionChanged: (username: string, token?: string) => Promise<void>;
	updateContactPresence: (username: string, status: 'online' | 'offline') => Promise<void>;
	initializeDefaultFriendGroup: (
		query: import('../../shared/actor').SqlQuery,
		userId: number,
		username: string
	) => Promise<void>;
}) => {
	const BCRYPT_SALT_ROUNDS = 10;
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
	const buildPayload = (user: UserRow) => ({
		id: user.id,
		avatar: user.avatar,
		username: user.username,
		name: user.name,
		phone: user.phone
	});
	const buildInfo = (user: UserRow) => ({
		id: user.id,
		avatar: user.avatar,
		username: user.username,
		name: user.name,
		phone: user.phone,
		created_at: formatTimestamp(user.created_at ?? 0),
		signature: user.signature
	});
	const {
		releaseUserCall,
		notifySessionChanged,
		updateContactPresence,
		initializeDefaultFriendGroup
	} = dependencies;
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
	const login = async (parameters: LoginInput): Promise<Outcome> => {
		const { username, password } = parameters || {};
		if (
			typeof username !== 'string' ||
			!username.trim() ||
			username.length > 50 ||
			typeof password !== 'string' ||
			!password ||
			Buffer.byteLength(password) > 72
		) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			const results = await repository.findUserByUsername<UserRow[]>([username]);
			if (results.length === 0) {
				return failure(AuthStatus.USER_OR_PASS_ERR);
			}
			const user: UserRow = results[0];
			// MySQL collation aliases must share a bucket based on the stored account ID.
			if (!(await consumeRateLimit(`auth:account:${user.id}`, boundedInteger('AUTH_ACCOUNT_RATE_LIMIT_MAX', 10), 300, 'reject')))
				return failure(AssistantStatus.RATE_LIMIT_ERR);
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
				return failure(AuthStatus.USER_OR_PASS_ERR);
			}
			// 升级旧 MD5 哈希为 bcrypt
			if (needUpgrade) {
				const newHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
				await repository.upgradePasswordHash([newHash, user.id]);
			}
			// 签发 token。允许重复登录：新 token 会覆盖 Redis 中旧 token，旧会话后续请求自然失效。
			const token = await issueToken(user, true);
			// 更新好友在线状态
			await updateContactPresence(username, 'online');
			return success({ token, info: buildInfo(user) });
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[auth] login 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const logout = async (actor: Actor, authorization?: string): Promise<Outcome> => {
		const username = actor?.username;
		if (!username) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			await updateContactPresence(username, 'offline');
			await better_chat.eval(
				"if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
				1,
				`token:${username}`,
				extractToken(authorization) || ''
			);
			await notifySessionChanged(username);
			await releaseUserCall(username);
			return success();
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[auth] logout 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const register = async (parameters: RegisterInput): Promise<Outcome> => {
		const { username, password, phone, avatar } = parameters || {};
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
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			await assertOwnedAvatar(0, avatar);

			const results_check = await repository.findRegistrationConflict<ExistingUserRow[]>([
				username,
				phone
			]);
			if (results_check.length !== 0) {
				return failure(AuthStatus.USER_EXIT_ERR);
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
				const result = await repository.insertUser<{ insertId: number }>(user, query);
				await initializeDefaultFriendGroup(query, result.insertId, username);
				const rows = await repository.findUserById<UserRow[]>([result.insertId], query);
				return rows[0];
			});
			return success({ info: buildInfo(info) });
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[auth] register 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const forgetPassword = async (
		actor: Actor,
		parameters: ForgetPasswordInput
	): Promise<Outcome> => {
		const { currentPassword, password } = parameters || {};
		const userId = actor?.id;
		if (
			!(userId && currentPassword && password) ||
			typeof currentPassword !== 'string' ||
			typeof password !== 'string' ||
			Buffer.byteLength(password) > 72
		) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			const results_check = await repository.findUserPassword<UserRow[]>([userId]);
			if (results_check.length === 0) {
				return failure(AuthStatus.USER_NOTEXIT_ERR);
			}
			const user = results_check[0] as UserRow;
			if (!user.password || !(await bcrypt.compare(currentPassword, user.password))) {
				return failure(AuthStatus.USER_OR_PASS_ERR);
			}
			const hash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

			const results_set = await repository.updateUserPassword<WriteResult>([hash, userId]);
			if (results_set.affectedRows === 1) {
				await better_chat.del(`token:${actor.username}`);
				await notifySessionChanged(actor.username);
				await releaseUserCall(actor.username);
				return success();
			}
			return failure(CommonStatus.UPDATE_ERR);
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[auth] forgetPassword 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const updateInfo = async (actor: Actor, parameters: UpdateInfoInput): Promise<Outcome> => {
		const { avatar, name, phone, signature } = parameters || {};
		const username = actor?.username;
		if (!username || typeof phone !== 'string' || !/^1[3-9]\d{9}$/.test(phone) ||
			(name !== undefined && (typeof name !== 'string' || name.length > 255)) ||
			(signature !== undefined && (typeof signature !== 'string' || signature.length > 5000))) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			const results_check = await repository.findPhoneOwner<ExistingUserRow[]>([phone]);
			if (results_check.length !== 0 && results_check[0].id !== actor.id) {
				return failure(AuthStatus.PHONE_EXIT_ERR);
			}
			await assertOwnedAvatar(actor.id, avatar);
			const info = { avatar, name, phone, signature };

			const results_set = await repository.updateUserProfile<WriteResult>([info, username]);
			if (results_set.affectedRows === 1) {
				const results_get = await repository.findUpdatedUser<UserRow[]>([username]);
				const user: UserRow = results_get[0];
				const token = await issueToken(user);
				return success({ token, info: buildInfo(user) });
			}
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[auth] updateInfo 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
		return failure(CommonStatus.UPDATE_ERR);
	};
	return { login, logout, register, forgetPassword, updateInfo };
};
