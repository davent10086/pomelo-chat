import type { WebSocket } from 'ws';
import type { Request, Response } from 'express';

import { CommonStatus } from '../../utils/status';
import { RespData, RespError } from '../../utils/resp';
import { formatBytes } from '../../utils/format';
import { NotificationUser } from '../../utils/notification';
import { verifyTokenWithSession } from '../../utils/authenticate';
import { Query } from '../../utils/query';

/**
 * 全局变量存储聊天室房间
 * 每个房间是一个对象，对象的键是用户 id / 群聊 id，值是 WebSocket 实例
 */
const ChatRooms: Record<string, Record<string, WebSocket>> = {};

/**
 * 检查 message_statistics 是否存在某条记录，如果不存在则创建后才修改，如果存在则直接修改
 */
const checkAndModifyStatistics = async (room: string): Promise<void> => {
	const sql_check = `SELECT * FROM message_statistics WHERE room = ?`;
	const results_check: any = await Query(sql_check, [room]);
	if (results_check.length === 0) {
		const sql_set = `INSERT INTO message_statistics SET ?`;
		await Query(sql_set, { room: room, total: 0 });
	}
	const sql_update = `UPDATE message_statistics SET total = total + 1 WHERE room = ?`;
	await Query(sql_update, [room]);
};

interface OutboundMessage {
	sender_id: any;
	receiver_id: any;
	content: any;
	room?: any;
	avatar?: any;
	type?: any;
	file_size?: any;
	created_at?: any;
	[name: string]: any;
}

interface InsertMessage {
	sender_id: any;
	receiver_id: any;
	content: any;
	room: string;
	type: string;
	media_type: any;
	file_size: any;
	status: number;
}

const authorizeChatRoom = async (userId: number | string, room: string, type: string) => {
	if (type === 'group') {
		const rows: any = await Query(
			`SELECT gc.id FROM group_chat gc JOIN group_members gm ON gm.group_id = gc.id WHERE gc.room = ? AND gm.user_id = ? LIMIT 1`,
			[room, userId]
		);
		return rows.length ? { receiverId: rows[0].id } : null;
	}
	if (type === 'private') {
		const rows: any = await Query(
			`SELECT f.user_id FROM friend f JOIN friend_group fg ON fg.id = f.group_id WHERE f.room = ? AND fg.user_id = ? LIMIT 1`,
			[room, userId]
		);
		return rows.length ? { receiverId: rows[0].user_id } : null;
	}
	return null;
};

/**
 * 将处理后的消息写入数据库和发送给房间内的所有人
 * L6: 不修改入参 message，构造新对象发送
 * H9: 访问 ChatRooms 前判空
 */
const writeAndSend = async (
	type: string,
	room: string,
	msg: InsertMessage,
	message: OutboundMessage
): Promise<void> => {
	// 判断是否已读
	if (
		type === 'group' ||
		(type === 'private' && ChatRooms[room] && ChatRooms[room][message.receiver_id])
	) {
		msg.status = 1;
	} else {
		msg.status = 0;
	}
	const sql_message = `INSERT INTO message SET ?`;
	await Query(sql_message, msg);
	await checkAndModifyStatistics(room);
	// L6: 构造新对象发送，不修改入参 message
	const outbound: OutboundMessage = {
		...message,
		created_at: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
		file_size: formatBytes(msg.file_size)
	};
	// H9: 判空保护，防止房间已被清理时崩溃
	const roomObj = ChatRooms[room];
	if (roomObj) {
		for (const key in roomObj) {
			try {
				roomObj[key].send(JSON.stringify(outbound));
			} catch (err: any) {
				console.error('[消息服务] send 失败 room=%s key=%s:', room, key, err.message);
			}
		}
	}
	// 通知对方有新消息以便刷新消息列表
	if (type === 'group') {
		const sql = `SELECT user_id FROM group_members WHERE group_id = ?`;
		const results: any = await Query(sql, [message.receiver_id]);
		for (const key in results) {
			if (results[key].user_id !== message.sender_id) {
				NotificationUser({ receiver_id: results[key].user_id, name: 'chatList' });
			}
		}
	} else {
		NotificationUser({ receiver_id: message.receiver_id, name: 'chatList' });
	}
};

/**
 * H10: 优化 getChatList，避免 N+1 查询 + 空结果崩溃
 * 使用 LEFT JOIN 一次性聚合未读数和最后消息
 */
export const getChatList = async (req: Request, res: Response): Promise<void> => {
	try {
		const data: any[] = [];
		const id = req.user!.id;
		// 私聊列表：通过 LEFT JOIN 一次性获取未读数、最后消息、头像
		const sql_private = `
			SELECT
				f.user_id AS receiver_id,
				f.remark AS name,
				u.username AS receiver_username,
				u.avatar,
				f.room,
				msg_sta.updated_at,
				IFNULL(unread.cnt, 0) AS unreadCount,
				last_msg.content AS lastMessage,
				IFNULL(last_msg.media_type, 'text') AS type
			FROM friend AS f
			INNER JOIN friend_group AS fp ON fp.id = f.group_id AND fp.user_id = ?
			INNER JOIN message_statistics AS msg_sta ON f.room = msg_sta.room
			LEFT JOIN user AS u ON u.id = f.user_id
			LEFT JOIN (
				SELECT room, COUNT(*) AS cnt FROM message
				WHERE receiver_id = ? AND status = 0 GROUP BY room
			) AS unread ON unread.room = f.room
			LEFT JOIN (
				SELECT m1.room, m1.content, m1.media_type
				FROM message m1
				INNER JOIN (
					SELECT room, MAX(created_at) AS max_time FROM message GROUP BY room
				) m2 ON m1.room = m2.room AND m1.created_at = m2.max_time
			) AS last_msg ON last_msg.room = f.room
			ORDER BY msg_sta.updated_at DESC;
		`;
		const results_private: any = await Query(sql_private, [id, id]);
		if (results_private && results_private.length) {
			data.push(...results_private);
		}

		// 群聊列表：同样用 LEFT JOIN 聚合
		const sql_group = `
			SELECT
				gc.id AS receiver_id,
				gc.avatar,
				gc.name,
				gc.room,
				msg_sta.updated_at,
				0 AS unreadCount,
				last_msg.content AS lastMessage,
				IFNULL(last_msg.media_type, 'text') AS type
			FROM group_chat AS gc
			INNER JOIN group_members AS gm ON gm.group_id = gc.id AND gm.user_id = ?
			INNER JOIN message_statistics AS msg_sta ON gc.room = msg_sta.room
			LEFT JOIN (
				SELECT m1.room, m1.content, m1.media_type
				FROM message m1
				INNER JOIN (
					SELECT room, MAX(created_at) AS max_time FROM message GROUP BY room
				) m2 ON m1.room = m2.room AND m1.created_at = m2.max_time
			) AS last_msg ON last_msg.room = gc.room
			ORDER BY msg_sta.updated_at DESC;
		`;
		const results_group: any = await Query(sql_group, [id]);
		if (results_group && results_group.length) {
			data.push(...results_group);
		}

		// 根据时间排序
		data.sort((a, b) => {
			const t1 = new Date(a.updated_at).getTime();
			const t2 = new Date(b.updated_at).getTime();
			return t2 - t1;
		});

		RespData(res, data);
	} catch (err: any) {
		console.error('[消息服务] getChatList 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/**
 * 建立聊天 websocket 连接
 * H3: 增加 token 认证
 * H9: close 回调判空
 * L6: JSON.parse 加 try/catch
 */
export const connectChat = async (ws: WebSocket, req: Request): Promise<void> => {
	const url = req.url!.split('?')[1];
	const params = new URLSearchParams(url);
	const room = params.get('room') || '';
	const id = params.get('id') || '';
	const type = params.get('type') || '';
	const token = params.get('token') || '';
	// H3: 校验 token，防止身份冒充
	const decoded = await verifyTokenWithSession(token);
	if (!decoded || String(decoded.id) !== String(id)) {
		ws.send(JSON.stringify({ name: 'error', message: '认证失败' }));
		ws.close(4001, 'unauthorized');
		return;
	}
	if (!(room && id && type) || !['private', 'group'].includes(type)) {
		ws.send(JSON.stringify({ name: 'error', message: '房间参数错误' }));
		ws.close();
		return;
	}
	try {
		const authorized = await authorizeChatRoom(decoded.id as string | number, room, type);
		if (!authorized) {
			ws.send(JSON.stringify({ name: 'error', message: '无权访问该聊天' }));
			ws.close(4003, 'forbidden');
			return;
		}
		// 重置聊天房间
		if (!ChatRooms[room]) {
			ChatRooms[room] = {};
		}
		ChatRooms[room][id] = ws;
		// 获取历史消息
		let results_msg: any;
		if (type === 'group') {
			const sql_group = `
			SELECT
				gm.nickname,
        m.*,
        u.avatar
			FROM
				(SELECT
					sender_id,
					receiver_id,
					content,
					room,
					media_type,
					file_size,
					message.created_at
				FROM message
				WHERE room = ? AND type = ?
				) AS m
				LEFT JOIN user AS u
				ON u.id = m.sender_id
				LEFT JOIN group_members AS gm
				ON gm.group_id = ?
        AND user_id = u.id
				ORDER BY created_at ASC
		`;
			results_msg = await Query(sql_group, [room, type, authorized.receiverId]);
		} else {
			const sql_private = `
			SELECT m.*,
        u.avatar
			FROM
				(SELECT
					sender_id,
					receiver_id,
					content,
					room,
					media_type,
					file_size,
					message.created_at
				FROM message
				WHERE room = ? AND type = ?
				ORDER BY created_at ASC
				) AS m
				LEFT JOIN user AS u
				ON u.id = m.sender_id
		`;
			results_msg = await Query(sql_private, [room, type]);
		}

		const historyMsg = (results_msg || []).map((item: any) => {
			return {
				sender_id: item.sender_id,
				receiver_id: item.receiver_id,
				content: item.content,
				room: item.room,
				avatar: item.avatar,
				type: item.media_type,
				file_size: formatBytes(item.file_size),
				created_at: new Date(item.created_at).toLocaleString('zh-CN', {
					timeZone: 'Asia/Shanghai'
				})
			};
		});
		ws.send(JSON.stringify(historyMsg));
		// 进入房间时，将所有未读消息变成已读
		const sql_set = `UPDATE message SET status = 1 WHERE receiver_id = ? AND room = ? AND type = ? AND status = 0`;
		await Query(sql_set, [id, room, type]);
		ws.on('message', async (data: any) => {
			// L6: JSON.parse 加 try/catch，畸形消息不影响连接
			let message: any;
			try {
				message = JSON.parse(data);
			} catch (err: any) {
				console.error('[消息管道] 消息解析失败:', err.message);
				ws.send(JSON.stringify({ name: 'error', message: '消息格式错误' }));
				return;
			}
			if (typeof message.content !== 'string' || message.content.length > 10000) {
				ws.send(JSON.stringify({ name: 'error', message: '消息内容无效' }));
				return;
			}
			const mediaType = ['text', 'image', 'video', 'file'].includes(message.type) ? message.type : 'text';
			const msg: InsertMessage = {
				sender_id: decoded.id,
				receiver_id: authorized.receiverId,
				content: message.content,
				room: room,
				type: type,
				media_type: mediaType,
				file_size: Number.isFinite(Number(message.fileSize)) ? Number(message.fileSize) : 0,
				status: 0
			};
			await writeAndSend(type, room, msg, { ...message, sender_id: decoded.id, receiver_id: authorized.receiverId });
		});
		ws.on('close', () => {
			// H9: 判空保护，房间可能已被清理
			if (ChatRooms[room] && ChatRooms[room][id]) {
				delete ChatRooms[room][id];
			}
		});

		ws.on('error', (err: any) => {
			console.error(`[消息管道] 连接出错 room=${room} id=${id}:`, err.message);
		});
	} catch (err: any) {
		console.error('[消息管道] connectChat 异常:', err.message);
		ws.send(
			JSON.stringify({
				name: 'error',
				message: '消息通道连接失败'
			})
		);
		ws.close();
		return;
	}
};
