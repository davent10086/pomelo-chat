import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';

import { CommonStatus, FriendStatus } from '../../utils/status';
import { RespData, RespSuccess, RespError } from '../../utils/resp';
import { NotificationUser } from '../../utils/notification';
import { Query, withTransaction } from '../../utils/query';

interface FriendRow {
	id: number;
	user_id: number | string;
	username: string;
	avatar?: string | null;
	remark?: string | null;
	online_status?: string;
	group_id: number | string;
	room: string;
}

interface FriendGroupIdRow { id: number; user_id?: number | string; }
interface FriendGroupRow extends FriendGroupIdRow { name: string; }
interface FriendGroupRecord extends FriendGroupRow { user_id: number | string; username: string; }
interface FriendDetailRow {
	friend_id: number;
	friend_user_id: number;
	online_status: string;
	remark: string | null;
	group_id: number;
	group_name: string;
	room: string;
	unread_msg_count: number;
	username: string;
	avatar: string | null;
	phone: string;
	name: string | null;
	signature: string | null;
}
interface UserSearchRow { id: number; name: string | null; username: string; avatar: string | null; }
interface FriendSearchItem extends UserSearchRow { status: boolean; }
interface FriendGroupListItem { name: string; online_counts: number; friend: FriendRow[]; }
interface WriteResult { affectedRows: number; insertId?: number; }

/**
 * 根据分组ID查询好友信息
 */
const getFriendByGroup = async (group_id: number): Promise<FriendRow[]> => {
	try {
		const sql = `SELECT * FROM friend WHERE group_id = ?`;
		const results = await Query<FriendRow[]>(sql, [group_id]);
		return results;
	} catch {
		throw new Error('查询失败');
	}
};

/**
 * 查询某个用户下的所有好友（数组平铺）
 */
const getFriendByUser = async (user_id: number | string): Promise<FriendRow[]> => {
	try {
		const friends: FriendRow[] = [];
		// 获取用户的所有分组
		const sql = `SELECT id FROM friend_group WHERE user_id = ?`;
		const results = await Query<FriendGroupIdRow[]>(sql, [user_id]);
		for (const group of results) {
			const results = await getFriendByGroup(group.id);
			friends.push(...results);
		}
		return friends;
	} catch {
		throw new Error('查询失败');
	}
};

/**
 * 搜索用户
 * 1. 查询用户表, 模糊查询
 * 2. 判断查询出来的数据中, 判断是否存在已经好友的现象
 * 3. 筛选出已经是好友的和不是好友的，非好友的才能添加
 */
export const searchUser = async (req: Request, res: Response): Promise<void> => {
	// 获取当前登录的用户信息、模糊查询关键字
	const sender = req.user!;
	const { username } = req.query || {};
	if (!(sender && username)) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const sql_get_user = `SELECT id, name, username, avatar FROM user WHERE username LIKE ?`;
		const results_user = await Query<UserSearchRow[]>(sql_get_user, [`%${username}%`]);
		// 获取当前用户的所有好友
		const friends = await getFriendByUser(sender.id);
		const searchList: FriendSearchItem[] = [];
		if (results_user.length !== 0) {
			for (const userInfo of results_user) {
				let flag = false;
				// 如果是自己，跳过
				if (userInfo.username === sender.username) {
					continue;
				}
				// 如果已经是好友，则增加标记
				for (const friend of friends) {
					if (friend.username === userInfo.username) {
						flag = true;
						break;
					}
				}
				// 返回的信息：昵称、用户名、用户 id、用户头像、是否是好友
				searchList.push({
					name: userInfo.name,
					username: userInfo.username,
					id: userInfo.id,
					avatar: userInfo.avatar,
					status: flag
				});
			}
		}
		RespData(res, searchList);
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[friend] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 添加好友
 * 1. 首先将好友添加到自己的好友列表中
 * 2. 然后将自己也插入到别人的好友列表中
 */
export const addFriend = async (req: Request, res: Response): Promise<void> => {
	const sender = req.user!;
	const { id, username } = req.body || {};
	const targetId = Number(id);
	if (!sender || !Number.isInteger(targetId) || targetId <= 0 || typeof username !== 'string' || !username.trim() || targetId === Number(sender.id)) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const uuid = randomUUID();
		const outcome = await withTransaction(async query => {
			const targetRows = await query<Array<{ id: number; username: string; avatar: string | null; name: string | null }>>(
				'SELECT id, username, avatar, name FROM user WHERE id = ? AND username = ? FOR UPDATE',
				[targetId, username.trim()]
			);
			if (!targetRows.length) return 'invalid';
			const groups = await query<FriendGroupIdRow[]>(
				'SELECT id, user_id FROM friend_group WHERE user_id IN (?, ?) ORDER BY user_id, id FOR UPDATE',
				[sender.id, targetId]
			);
			const senderGroup = groups.find(group => String(group.user_id) === String(sender.id));
			const targetGroup = groups.find(group => String(group.user_id) === String(targetId));
			if (!senderGroup || !targetGroup) throw new Error('default friend group missing');
			const existing = await query<Array<{ id: number }>>(
				'SELECT id FROM friend WHERE (group_id = ? AND user_id = ?) OR (group_id = ? AND user_id = ?) FOR UPDATE',
				[senderGroup.id, targetId, targetGroup.id, sender.id]
			);
			if (existing.length) return 'exists';
			const target = targetRows[0];
			await query('INSERT INTO friend SET ?', {
				user_id: target.id, username: target.username, avatar: target.avatar,
				online_status: LoginRooms[target.username] ? 'online' : 'offline', remark: target.username, group_id: senderGroup.id, room: uuid
			});
			await query('INSERT INTO friend SET ?', {
				user_id: sender.id, username: sender.username, avatar: sender.avatar,
				online_status: LoginRooms[sender.username] ? 'online' : 'offline', remark: sender.name, group_id: targetGroup.id, room: uuid
			});
			return 'created';
		});
		if (outcome === 'invalid') return RespError(res, CommonStatus.NOT_FOUND);
		if (outcome === 'exists') return RespError(res, FriendStatus.FRIEND_ALREADY_ADDED);
		void NotificationUser({ receiver_username: username.trim(), name: 'friendList' }).catch(error => console.error('[friend] notification failed:', error));
		void NotificationUser({ receiver_username: sender.username, name: 'friendList' }).catch(error => console.error('[friend] notification failed:', error));
		RespSuccess(res);
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[friend] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 获取好友列表
 * 1. 根据当前用户的 id 获取其所有好友分组的 id 和 name
 * 2. 然后查询各个分组下的好友，最后拼接在一起返回
 */
export const getFriendList = async (req: Request, res: Response): Promise<void> => {
	try {
		const sender = req.user!;
		const sql = `SELECT id, name FROM friend_group WHERE user_id = ?`;
		// 获取当前用户的所有分组
		const results = await Query<FriendGroupRow[]>(sql, [sender.id]);
		const friendList: FriendGroupListItem[] = [];
		if (results.length !== 0) {
			// 获取每个分组下的好友
			for (const result of results) {
				const groupFriends: FriendGroupListItem = { name: result.name, online_counts: 0, friend: [] };
				const friends = await getFriendByGroup(result.id);
				// 在线好友数量
				for (const friend of friends) {
					groupFriends.friend.push(friend);
					if (friend.online_status === 'online') {
						groupFriends.online_counts++;
					}
				}
				friendList.push(groupFriends);
			}
		}
		RespData(res, friendList);
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[friend] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 根据好友ID获取好友信息
 * 联表查询 friend 表与 user 表、friend_group 表
 */
export const getFriendById = async (req: Request, res: Response): Promise<void> => {
	const { id } = req.query || {};
	if (!id) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const sql = `
			SELECT
				f.id AS friend_id,
				f.user_id AS friend_user_id,
				f.online_status,
				f.remark,
				f.group_id,
				fg.name AS group_name,
				f.room,
				f.unread_msg_count,
				u.username,
				u.avatar,
				u.phone,
				u.name,
				u.signature
			FROM
				friend AS f
			JOIN
				user AS u ON f.user_id = u.id
			JOIN
				friend_group AS fg ON f.group_id = fg.id
			WHERE
				f.id = ? AND fg.user_id = ?
		`;
		const results = await Query<FriendDetailRow[]>(sql, [id, req.user!.id]);
		if (results.length !== 0) {
			RespData(res, results[0]);
		}
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[friend] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 获取当前用户的分组列表
 */
export const getFriendGroupList = async (req: Request, res: Response): Promise<void> => {
	const user_id = req.user!.id;
	if (!user_id) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const sql = `SELECT * FROM friend_group WHERE user_id = ?`;
		const results = await Query<FriendGroupRecord[]>(sql, [user_id]);
		RespData(res, results);
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[friend] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 添加好友分组
 */
export const createFriendGroup = async (req: Request, res: Response): Promise<void> => {
	const name = req.body?.name;
	if (typeof name !== 'string' || !name.trim()) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const sql = `INSERT INTO friend_group SET ?`;
		const results = await Query<WriteResult>(sql, {
			user_id: req.user!.id,
			username: req.user!.username,
			name: name.trim()
		});
		if (results.affectedRows === 1) {
			RespSuccess(res);
		}
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[friend] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 修改好友信息（备注、分组）
 */
export const updateFriend = async (req: Request, res: Response): Promise<void> => {
	const { friend_id, remark, group_id } = req.body || {};
	if (!(friend_id && remark && group_id)) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const sql = `UPDATE friend AS f JOIN friend_group AS target ON target.id = ? AND target.user_id = ? JOIN friend_group AS owner ON owner.id = f.group_id AND owner.user_id = ? SET f.remark = ?, f.group_id = ? WHERE f.id = ?`;
		const results = await Query<WriteResult>(sql, [group_id, req.user!.id, req.user!.id, remark, group_id, friend_id]);
		if (results.affectedRows === 1) {
			RespSuccess(res);
		}
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[friend] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};
