import type { WebSocket } from 'ws';
import type { Request, Response } from 'express';

import { CommonStatus } from '../../utils/status';
import { RespData, RespError } from '../../utils/resp';
import { Query } from '../../utils/query';
import { verifyTokenWithSession } from '../../utils/authenticate';

const canAccessRoom = async (userId: number | string, room: string, type: string): Promise<boolean> => {
	const sql =
		type === 'group'
			? `SELECT 1 FROM group_chat gc JOIN group_members gm ON gm.group_id = gc.id WHERE gc.room = ? AND gm.user_id = ? LIMIT 1`
			: type === 'private'
				? `SELECT 1 FROM friend f JOIN friend_group fg ON fg.id = f.group_id WHERE f.room = ? AND fg.user_id = ? LIMIT 1`
				: '';
	if (!sql) return false;
	const rows: any = await Query(sql, [room, userId]);
	return rows.length > 0;
};

const ChatRTCRooms: Record<string, Record<string, WebSocket>> = {}; // 全局变量存储聊天室房间，每个房间是一个对象，对象的键是用户名 username，值是 WebSocket 实例

/**
 * 向房间内除指定用户外的其他用户广播消息
 * @param username - 发送消息的用户名
 * @param room - 房间名
 * @param msg - 要发送的消息对象
 * @param isNeedCalling - 是否需要接收方正在通话状态才发送消息
 */
const broadcastSocket = (
	username: string,
	room: string,
	msg: any,
	isNeedCalling = true
): void => {
	for (const key in ChatRTCRooms[room]) {
		if (key === username) {
			continue;
		}
		const ws = ChatRTCRooms[room][key];
		if (ws) {
			// isNeedCalling 为 true 时，需要对方正在通话状态才发送消息，否则不发送
			const shouldSend = isNeedCalling ? !!(LoginRooms[key] && LoginRooms[key].status) : true;
			if (shouldSend) {
				ws.send(JSON.stringify(msg));
			}
		}
	}
};

/**
 * 根据好友用户名获取好友相关信息
 */
const getFriendByUsername = async (
	friend_username: string,
	self_username: string
): Promise<any | undefined> => {
	try {
		const sql = `
			SELECT
				*
			FROM
				friend
			WHERE
				username = ?
			AND group_id IN (
				SELECT
					id
				FROM
					friend_group
				WHERE
					username = ?
			)
		`;
		const results: any = await Query(sql, [friend_username, self_username]);
		if (results.length !== 0) {
			return results[0];
		}
	} catch {
		throw new Error('查询失败');
	}
};

/**
 * 音视频聊天的基本逻辑：(参考博客：https://segmentfault.com/a/1190000041614675)
 * 1、邀请人点击音视频按钮，建立 ws 连接并向对方发送 create_room 指令
 * ... (详见原注释)
 */
export const connectRTC = async (ws: WebSocket, req: Request): Promise<void> => {
	const url = req.url!.split('?')[1];
	const params = new URLSearchParams(url);
	const room = params.get('room') || '';
	const username = params.get('username') || '';
	const type = params.get('type') || '';
	const token = params.get('token') || '';
	const decoded = await verifyTokenWithSession(token);
	if (
		!(room && username && type) ||
		!decoded ||
		decoded.username !== username ||
		!(await canAccessRoom(decoded.id as string | number, room, type))
	) {
		ws.send(JSON.stringify({ name: 'connect_fail', reason: 'unauthorized' }));
		ws.close(4001, 'unauthorized');
		return;
	}
	if (!['private', 'group'].includes(type)) {
		ws.close();
		return;
	}
	try {
		if (!ChatRTCRooms[room]) {
			ChatRTCRooms[room] = {};
		}
		ChatRTCRooms[room][username] = ws;
		ws.on('message', async (data: any) => {
			const message = JSON.parse(data); // 服务端接收到的 message 包含 name、mode、callReceiverList、data、receiver，其中只有 name 指令名称是必须收到的，mode 和 callReceiverList 是 create_room 时收到的，data、receiver 是 offer、answer、ice_candidate 时收到的
			const { callReceiverList } = message;
			let msg: any;
			switch (message.name) {
				/**
				 * create_room：邀请人发送邀请，被邀请人接收邀请
				 */
				case 'create_room':
					if (!LoginRooms[username]) {
						ws.send(
							JSON.stringify({
								name: 'connect_fail',
								reason: '你已经下线了!!!'
							})
						);
						return;
					}
					if (LoginRooms[username].status) {
						ws.send(
							JSON.stringify({
								name: 'connect_fail',
								reason: '你正在通话中, 请勿发送其他通话请求...'
							})
						);
						return;
					}
					// 私聊时
					if (type === 'private') {
						if (!LoginRooms[callReceiverList[0].username]) {
							ws.send(JSON.stringify({ name: 'connect_fail', reason: '对方当前不在线!!!' }));
							return;
						}
						if (LoginRooms[callReceiverList[0].username].status) {
							ws.send(JSON.stringify({ name: 'connect_fail', reason: '对方正在通话中!!!' }));
							return;
						}
					}
					// 群聊时
					if (type === 'group') {
						// 群聊时的处理较为复杂，需要遍历所有的接收者（记得先排除邀请方），判断是否在线，是否空闲，无法邀请的删除，之后更新 callReceiverList
						for (let i = 0; i < callReceiverList.length; i++) {
							const receiver_username = callReceiverList[i].username;
							if (receiver_username !== username) {
								if (!LoginRooms[receiver_username]) {
									callReceiverList.splice(i, 1);
									i--;
									continue;
								}
								if (LoginRooms[receiver_username].status) {
									callReceiverList.splice(i, 1);
									i--;
									continue;
								}
							}
						}
						// 如果此时没有可以通话的人 (即此时的 callReceiverList 里只有邀请方自己)
						if (callReceiverList.length === 1) {
							ws.send(JSON.stringify({ name: 'connect_fail', reason: '当前没有可以通话的人!!!' }));
							return;
						}
					}

					// 设置当前用户通话状态
					LoginRooms[username].status = true;
					// 发送邀请 —— 利用 LoginRooms 存储的 ws 连接实例向在线且空闲的被邀请人发送邀请
					for (let i = 0; i < callReceiverList.length; i++) {
						const receiver_username = callReceiverList[i].username;
						if (receiver_username === username) {
							continue;
						}
						// 每个被邀请人都要拿到聊天房间内其它人的信息（即将当前的 callReceiverList 进行处理：排除自己和加上邀请方），方便后续用到
						const newCallReceiverList = callReceiverList.filter(
							(item: any) => item.username !== receiver_username
						);
						if (type === 'private') {
							const friendInfo = await getFriendByUsername(username, receiver_username); // 此时邀请方是当前 receiver 的好友
							newCallReceiverList.push({
								username: username,
								avatar: friendInfo.avatar,
								alias: friendInfo.remark
							});
						}
						msg = {
							name: 'create_room',
							room: room,
							mode: message.mode,
							callReceiverList: newCallReceiverList
						};
						LoginRooms[receiver_username].ws.send(JSON.stringify(msg));
					}
					break;
				/**
				 * new_peer：告诉房间内其他人自己要进入房间
				 */
				case 'new_peer':
					msg = {
						name: 'new_peer',
						sender: username
					};
					// 设置当前用户通话状态
					LoginRooms[username].status = true;
					broadcastSocket(username, room, msg);
					break;
				/**
				 * offer：发送自己 offer 信息给进入房间的新人（ offer 信息包含自己的 SDP 信息）
				 */
				case 'offer':
					msg = {
						name: 'offer',
						data: message.data,
						sender: username
					};
					ChatRTCRooms[room][message.receiver].send(JSON.stringify(msg));
					break;
				/**
				 * answer：此时已收到并设置对方发送过来的 SDP 后，也发送自己的 SDP 给对方
				 */
				case 'answer':
					msg = {
						name: 'answer',
						data: message.data,
						sender: username
					};
					ChatRTCRooms[room][message.receiver].send(JSON.stringify(msg));
					break;
				/**
				 * ice_candidate：设置对方的 candidate ———— 双方都可能收到，此时双方的 ICE 设置完毕，可以进行音视频通话
				 */
				case 'ice_candidate':
					msg = {
						name: 'ice_candidate',
						data: message.data,
						sender: username
					};
					ChatRTCRooms[room][message.receiver].send(JSON.stringify(msg));
					break;
				/**
				 * 拒绝 / 挂断通话
				 */
				case 'reject':
					msg = {
						name: 'reject',
						sender: username
					};
					broadcastSocket(username, room, msg);
					delete ChatRTCRooms[room][username];
					LoginRooms[username].status = false;
					break;
			}
		});
		ws.on('close', () => {
			if (ChatRTCRooms[room][username]) {
				delete ChatRTCRooms[room][username];
				if (LoginRooms[username]) {
					LoginRooms[username].status = false;
				}
			}
		});

		ws.on('error', (err: any) => {
			console.error(`[RTC管道] 连接出错 room=${room} username=${username}:`, err.message);
		});
	} catch (err: any) {
		console.error('[RTC管道] connectRTC 异常:', err.message);
		ws.send(
			JSON.stringify({
				name: 'connect_fail',
				reason: '服务有误，请稍后重试'
			})
		);
		ws.close();
		return;
	}
};

/**
 * 获取当前房间内正在通话的所有人
 */
export const getRoomMembers = async (req: Request, res: Response): Promise<void> => {
	const url = req.url!.split('?')[1];
	const params = new URLSearchParams(url);
	const room = params.get('room') || '';
	const username = req.user!.username;
	if (!room) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	try {
		const privateAccess = await canAccessRoom(req.user!.id, room, 'private');
		const groupAccess = await canAccessRoom(req.user!.id, room, 'group');
		if (!privateAccess && !groupAccess) {
			RespError(res, CommonStatus.TOKEN_ERR);
			return;
		}
		const data: string[] = [];
		for (const key in ChatRTCRooms[room]) {
			if (key === String(username) || !(LoginRooms[key] && LoginRooms[key].status)) {
				continue;
			}
			data.push(key);
		}
		RespData(res, data);
	} catch (err: any) {
		console.error('[rtc] 异常:', err.message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};
