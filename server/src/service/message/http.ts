import type { Request, Response } from 'express';
import { Query } from '../../utils/query';
import { CommonStatus } from '../../utils/status';
import { RespData, RespError } from '../../utils/resp';
import { authorizeChatRoom } from './permissions';
import { fetchHistoryMessages, markRoomRead } from './queries';
import { HISTORY_PAGE_SIZE, isChatType, type ChatListItem } from './contracts';
export const getChatList = async (req: Request, res: Response): Promise<void> => {
	try {
		const data: ChatListItem[] = [];
		const id = req.user!.id;
		const privateSql = `
			SELECT
				f.user_id AS receiver_id,
				f.remark AS name,
				u.username AS receiver_username,
				u.avatar,
				f.room,
				COALESCE(c.updated_at, msg_sta.updated_at, f.updated_at) AS updated_at,
				IFNULL(unread.cnt, 0) AS unreadCount,
				last_msg.content AS lastMessage,
				IFNULL(last_msg.media_type, 'text') AS type
			FROM friend AS f
			INNER JOIN friend_group AS fp ON fp.id = f.group_id AND fp.user_id = ?
			LEFT JOIN conversation AS c ON c.room = f.room
			LEFT JOIN message_statistics AS msg_sta ON f.room = msg_sta.room
			LEFT JOIN user AS u ON u.id = f.user_id
			LEFT JOIN (
				SELECT room, COUNT(*) AS cnt FROM message
				WHERE receiver_id = ? AND status = 0 GROUP BY room
			) AS unread ON unread.room = f.room
			LEFT JOIN message AS last_msg ON last_msg.id = c.last_message_id
			ORDER BY updated_at DESC;
		`;
		data.push(...(await Query<ChatListItem[]>(privateSql, [id, id])));

		const groupSql = `
			SELECT
				gc.id AS receiver_id,
				gc.avatar,
				gc.name,
				gc.room,
				COALESCE(c.updated_at, msg_sta.updated_at, gc.updated_at) AS updated_at,
				GREATEST(COALESCE(c.last_seq, 0) - COALESCE(cr.last_read_seq, 0), 0) AS unreadCount,
				last_msg.content AS lastMessage,
				IFNULL(last_msg.media_type, 'text') AS type
			FROM group_chat AS gc
			INNER JOIN group_members AS gm ON gm.group_id = gc.id AND gm.user_id = ?
			LEFT JOIN conversation AS c ON c.room = gc.room
			LEFT JOIN conversation_read AS cr ON cr.conversation_id = c.id AND cr.user_id = ?
			LEFT JOIN message_statistics AS msg_sta ON gc.room = msg_sta.room
			LEFT JOIN message AS last_msg ON last_msg.id = c.last_message_id
			ORDER BY updated_at DESC;
		`;
		data.push(...(await Query<ChatListItem[]>(groupSql, [id, id])));
		data.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
		RespData(res, data);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[message] getChatList error:', message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

export const getHistory = async (req: Request, res: Response): Promise<void> => {
	const room = typeof req.query.room === 'string' ? req.query.room : '';
	const type =
		typeof req.query.type === 'string' && isChatType(req.query.type) ? req.query.type : null;
	const beforeId = req.query.beforeId ? Number(req.query.beforeId) : undefined;
	const limit = req.query.limit ? Number(req.query.limit) : HISTORY_PAGE_SIZE;
	const afterSeq = req.query.afterSeq !== undefined ? Number(req.query.afterSeq) : undefined;
	if (
		!room ||
		!type ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		(beforeId !== undefined && (!Number.isSafeInteger(beforeId) || beforeId < 1)) ||
		(afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0))
	)
		return RespError(res, CommonStatus.PARAM_ERR);
	try {
		const result = await fetchHistoryMessages(req.user!.id, room, type, beforeId, limit, afterSeq);
		if (!result) return RespError(res, CommonStatus.TOKEN_ERR);
		RespData(res, {
			messages: result.messages,
			hasMore: result.hasMore,
			nextBeforeId: result.nextBeforeId
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[message] getHistory error:', message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

export const markRead = async (req: Request, res: Response): Promise<void> => {
	const room = typeof req.body?.room === 'string' ? req.body.room : '';
	const type =
		typeof req.body?.type === 'string' && isChatType(req.body.type) ? req.body.type : null;
	const roomSeq = Number(req.body?.roomSeq);
	if (!room || !type || !Number.isSafeInteger(roomSeq) || roomSeq < 0)
		return RespError(res, CommonStatus.PARAM_ERR);
	try {
		const authorized = await authorizeChatRoom(req.user!.id, room, type);
		if (!authorized) return RespError(res, CommonStatus.TOKEN_ERR);
		await markRoomRead(req.user!.id, room, type, Number.isFinite(roomSeq) ? roomSeq : undefined);
		RespData(res, { room, read: true, roomSeq: Number.isFinite(roomSeq) ? roomSeq : undefined });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[message] markRead error:', message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};
