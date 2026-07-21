import { v4 as uuidv4 } from 'uuid';
import type { Request, Response } from 'express';

import { CommonStatus, GroupStatus } from '../../utils/status';
import { RespData, RespSuccess, RespError } from '../../utils/resp';
import { NotificationUser } from '../../utils/notification';
import { Query } from '../../utils/query';

/**
 * 查询群聊成员信息
 * 1. 根据 group_id 查询 group_members 表获取群成员的 user_id、nickname 和 created_at
 * 2. 并查询 user 表获取成员 username、name 和 avatar
 * 3. 使用 left join 根据 sender_id 和 room 查询 message 表获取用户的最后一次发消息时间
 */
const getGroupMembers = async (group_id: number | string, room: string): Promise<any[]> => {
	try {
		const sql = `
			SELECT
				s.*,
				m.lastMessageTime
			FROM
				(SELECT
					user_id,
					user.avatar,
					user.username,
					user.name,
					nickname,
					group_members.created_at
				FROM group_members, user
				WHERE group_id = ? AND user_id = user.id
				) AS s
				LEFT JOIN
				(SELECT
					sender_id,
					Max(created_at) AS lastMessageTime
				FROM message AS msg
				WHERE msg.room = ?
				GROUP BY sender_id
				) AS m
				ON m.sender_id = s.user_id
		`;
		const results: any = await Query(sql, [group_id, room]);
		return results;
	} catch {
		throw new Error('查询失败');
	}
};

const canAccessGroup = async (userId: number | string, groupId: number | string): Promise<boolean> => {
	const rows: any = await Query(
		`SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1`,
		[groupId, userId]
	);
	return rows.length > 0;
};

/**
 * 创建群聊
 * 1. 服务端拿到创建群聊所需要的信息后在群聊表 (group_chat) 新建一个群聊
 * 2. 在群聊成员表 (group_members) 中循环插入所有群聊成员记录并通知刷新群聊列表
 */
export const createGroupChat = async (req: Request, res: Response): Promise<void> => {
	const groupInfo = req.body || {};
	if (
		typeof groupInfo.name !== 'string' ||
		!groupInfo.name.trim() ||
		!Array.isArray(groupInfo.members)
	) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const uuid = uuidv4();
		const group_chat = {
			name: groupInfo.name,
			creator_id: req.user!.id,
			avatar: groupInfo.avatar,
			announcement: groupInfo.announcement,
			room: uuid
		};

		const sql_group = `INSERT INTO group_chat SET ?`;
		const results_group: any = await Query(sql_group, group_chat);
		if (results_group.affectedRows === 1) {
			// 发送固定消息
			const message = {
				sender_id: req.user!.id,
				receiver_id: results_group.insertId,
				type: 'group',
				media_type: 'text',
				status: 0,
				content: '大家可以一起聊天了!',
				room: uuid
			};
			const sql_message = `INSERT INTO message SET ?`;
			await Query(sql_message, message);
			const sql_message_statistics = `INSERT INTO message_statistics SET ?`;
			await Query(sql_message_statistics, { room: uuid, total: 1 });

			// 插入自己
			const members = [
				...groupInfo.members,
				{
					user_id: req.user!.id,
					username: req.user!.name,
					avatar: req.user!.avatar
				}
			];
			// 插入成员
			for (const member of members) {
				const memberInfo = {
					group_id: results_group.insertId,
					user_id: member.user_id,
					nickname: member.username
				};
				const sql_members = `INSERT INTO group_members SET ?`;
				await Query(sql_members, memberInfo);
				// 通知所有群成员, 让其群聊列表进行更新
				NotificationUser({
					receiver_username: member.username,
					name: 'groupChatList'
				});
			}
			RespSuccess(res);
		}
	} catch (err: any) {
		console.error('[group] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 获取当前用户加入的所有群聊
 * 根据 group_members 获取所有 group_id, 再 left join group_chat 获取对应群聊信息
 */
export const getGroupChatList = async (req: Request, res: Response): Promise<void> => {
	const id = req.user!.id;
	if (!id) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const sql = `
			SELECT
				gct.*
			FROM
				(
					(
						SELECT
							group_id
						FROM
							group_members
						WHERE
							user_id = ?
					) AS gmb
					LEFT JOIN group_chat AS gct ON gmb.group_id = gct.id
				)
		`;
		const results: any = await Query(sql, [id]);
		RespData(res, results);
	} catch (err: any) {
		console.error('[group] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 模糊查询群聊
 * 1. 根据 name 查询 group_chat 获取相似的所有群聊
 * 2. 根据 user_id 和 id 查询 group_members 判断当前用户是否加入群聊
 */
export const searchGroupChat = async (req: Request, res: Response): Promise<void> => {
	const { name } = req.query || {};
	if (!name) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const sql_group = `SELECT * FROM group_chat WHERE name LIKE ?`;
		const results_group: any = await Query(sql_group, [`%${name}%`]);
		const searchList: any[] = [];
		if (results_group.length !== 0) {
			const { id } = req.user!;
			const sql_members = `SELECT user_id FROM group_members WHERE group_id = ?`;
			for (const item of results_group) {
				let status = false;
				const results_members: any = await Query(sql_members, [item.id]);
				for (const member of results_members) {
					if (member.user_id === id) {
						status = true;
						break;
					}
				}
				searchList.push({
					name: item.name,
					avatar: item.avatar,
					number: results_members.length,
					status: status,
					group_id: item.id
				});
			}
		}
		RespData(res, searchList);
	} catch (err: any) {
		console.error('[group] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 获取群聊信息
 * 需要获取群介绍, 群主, 所有群成员
 */
export const getGroupChatInfo = async (req: Request, res: Response): Promise<void> => {
	const group_id = (req.query as any).group_id;
	if (!group_id) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		if (!(await canAccessGroup(req.user!.id, group_id))) {
			RespError(res, CommonStatus.TOKEN_ERR);
			return;
		}
		const sql = `
			SELECT
				gc.id,
				gc.name,
				gc.creator_id,
				u.username AS creator_username,
				gc.avatar,
				gc.announcement,
				gc.room,
				gc.created_at
			FROM group_chat gc
			JOIN user u
				ON gc.creator_id = u.id
			WHERE gc.id = ?
		`;
		const results_group: any = await Query(sql, [group_id]);
		if (!results_group.length) {
			RespError(res, CommonStatus.NOT_FOUND);
			return;
		}
		const info: any = {
			id: results_group[0].id,
			name: results_group[0].name,
			creator_id: results_group[0].creator_id,
			creator_username: results_group[0].creator_username,
			avatar: results_group[0].avatar,
			announcement: results_group[0].announcement,
			room: results_group[0].room,
			created_at: results_group[0].created_at,
			members: []
		};
		const results_members = await getGroupMembers(group_id, info.room);
		for (const member of results_members) {
			info.members.push({ ...member });
		}
		RespData(res, info);
	} catch (err: any) {
		console.error('[group] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 邀请新的好友进入群聊
 * 1. 获取邀请名单和 group_id
 * 2. 过滤掉已经存在群里的用户
 * 3. 在 group_members 表插入新的数据
 */
export const inviteFriendToGroupChat = async (req: Request, res: Response): Promise<void> => {
	const { groupId, invitationList } = req.body || {};
	if (!(groupId && Array.isArray(invitationList) && invitationList.length)) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		if (!(await canAccessGroup(req.user!.id, groupId))) {
			RespError(res, CommonStatus.TOKEN_ERR);
			return;
		}
		const userIdArr = invitationList.map((item: any) => item.user_id);
		const sql_check = `
			SELECT user_id
			FROM group_members
			WHERE group_id = ? AND FIND_IN_SET(user_id, ?)
		`;
		const results_check: any = await Query(sql_check, [groupId, userIdArr.join(',')]);
		// 过滤掉已经存在群里的用户
		const invitationInfoList: any[] = [];
		const hasInvitedUserIdArr = results_check.map((item: any) => item.user_id);
		for (const item of invitationList) {
			if (!hasInvitedUserIdArr.includes(item.user_id)) {
				invitationInfoList.push({
					group_id: groupId,
					user_id: item.user_id,
					nickname: item.username
				});
			}
		}
		if (invitationInfoList.length === 0) {
			RespError(res, GroupStatus.ALL_EXIT_ERR);
			return;
		}
		// 插入新的成员
		const sql_set = `INSERT INTO group_members (group_id, user_id, nickname) VALUES ?`;
		await Query(sql_set, [invitationInfoList.map(item => [item.group_id, item.user_id, item.nickname])]);
		// 通知对方, 让其群聊列表进行更新
		for (const item of invitationInfoList) {
			NotificationUser({
				receiver_username: item.nickname,
				name: 'groupChatList'
			});
		}
		RespSuccess(res);
	} catch (err: any) {
		console.error('[group] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 加入新的群聊
 * 1. 先判断是否已经加入了该群聊
 * 2. 如果没有加入，则插入新的数据到 group_members、group_chat 表即可
 */
export const joinGroupChat = async (req: Request, res: Response): Promise<void> => {
	const sender = req.user!;
	const group_id = req.body.group_id;
	if (!group_id) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		// 检查是否已经加入了该群聊
		const sql_check = `SELECT id FROM group_members WHERE group_id = ? AND user_id = ?`;
		const results_check: any = await Query(sql_check, [group_id, sender.id]);
		if (results_check.length !== 0) {
			RespError(res, GroupStatus.EXIT_GROUP_ERR);
			return;
		}
		// 插入新的数据
		const info = {
			group_id: group_id,
			user_id: sender.id,
			nickname: sender.name
		};
		const sql_set = `INSERT INTO group_members SET ?`;
		await Query(sql_set, info);
		const sql_get = `SELECT name, room FROM group_chat WHERE id = ?`;
		const results_get: any = await Query(sql_get, [group_id]);
		if (!results_get.length) {
			RespError(res, CommonStatus.NOT_FOUND);
			return;
		}
		const options = {
			room: results_get[0].room,
			name: results_get[0].name,
			group_id: group_id
		};
		// 通知自己，让群聊列表进行更新
		NotificationUser({
			receiver_username: sender.name,
			name: 'groupChatList'
		});
		RespData(res, options);
	} catch (err: any) {
		console.error('[group] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 获取群聊成员信息
 */
export const getGroupMemberList = async (req: Request, res: Response): Promise<void> => {
	const { group_id, room } = (req.query as any) || {};
	if (!(group_id && room)) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		if (!(await canAccessGroup(req.user!.id, group_id))) {
			RespError(res, CommonStatus.TOKEN_ERR);
			return;
		}
		const group: any = await Query(`SELECT room FROM group_chat WHERE id = ?`, [group_id]);
		if (!group.length || group[0].room !== room) {
			RespError(res, CommonStatus.PARAM_ERR);
			return;
		}
		const results = await getGroupMembers(group_id, room);
		RespData(res, results);
	} catch (err: any) {
		console.error('[group] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};
