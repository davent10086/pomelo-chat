import type { RawData, WebSocket } from 'ws';
import type { Request, Response } from 'express';

import { CommonStatus } from '../../utils/status';
import { RespData, RespError } from '../../utils/resp';
import { formatBytes } from '../../utils/format';
import { NotificationUser } from '../../utils/notification';
import { better_chat, verifyTokenWithSession } from '../../utils/authenticate';
import { Query, withTransaction } from '../../utils/query';

const ChatRooms: Record<string, Record<string, WebSocket>> = {};
const MESSAGE_FANOUT_CHANNEL = 'pomelo:message:fanout';
const INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

type ChatType = 'private' | 'group';
type MediaType = 'text' | 'image' | 'video' | 'file';
type UserId = number | string;

const HISTORY_PAGE_SIZE = 30;
const MAX_HISTORY_PAGE_SIZE = 80;
const MAX_MESSAGE_LENGTH = 10000;

const isChatType = (value: string): value is ChatType => value === 'private' || value === 'group';
const isMediaType = (value: unknown): value is MediaType =>
	value === 'text' || value === 'image' || value === 'video' || value === 'file';
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

interface ConversationRow {
	id: number;
	last_seq: number;
}

interface WriteResult {
	insertId: number;
	affectedRows: number;
}

interface GroupMembershipRow {
	id: number;
}

interface FriendMembershipRow {
	user_id: number;
}

interface GroupMemberRow {
	user_id: number;
}

interface HistoryMessageRow {
	id: number;
	client_msg_id: string | null;
	room_seq: number;
	sender_id: UserId;
	receiver_id: UserId;
	content: string;
	room: string;
	media_type: MediaType;
	file_size: number;
	created_at: Date | string;
	avatar: string | null;
}

interface ChatListItem {
	receiver_id: number;
	name?: string | null;
	receiver_username?: string | null;
	avatar: string | null;
	room: string;
	updated_at: Date | string;
	unreadCount: number;
	lastMessage: string | null;
	type: MediaType;
}

interface IncomingMessage {
	content: string;
	type?: unknown;
	fileSize?: unknown;
	clientMsgId?: unknown;
}

interface InsertMessage {
	conversation_id?: number;
	client_msg_id?: string | null;
	room_seq?: number;
	sender_id: UserId;
	receiver_id: UserId;
	content: string;
	room: string;
	type: ChatType;
	media_type: MediaType;
	file_size: number;
	status: number;
}

interface OutboundMessage {
	id?: number;
	client_msg_id?: string | null;
	room_seq?: number;
	sender_id: UserId;
	receiver_id: UserId;
	content: string;
	room?: string;
	avatar?: string | null;
	type?: MediaType;
	file_size?: number | string;
	created_at?: string;
}

interface FanoutPayload {
	instanceId: string;
	room: string;
	message: OutboundMessage;
}

const sendLocalRoom = (room: string, message: OutboundMessage): void => {
	for (const key in ChatRooms[room] || {}) {
		try {
			ChatRooms[room][key].send(JSON.stringify(message));
		} catch (err: unknown) {
			const messageText = err instanceof Error ? err.message : String(err);
			console.error('[message] send failed room=%s key=%s: %s', room, key, messageText);
		}
	}
};

const publishRoomMessage = async (room: string, message: OutboundMessage): Promise<void> => {
	try {
		await better_chat.publish(MESSAGE_FANOUT_CHANNEL, JSON.stringify({ instanceId: INSTANCE_ID, room, message }));
	} catch (err: unknown) {
		const messageText = err instanceof Error ? err.message : String(err);
		console.error('[message] redis fanout publish failed:', messageText);
	}
};

const subscribeRoomFanout = (): void => {
	const subscriber = better_chat.duplicate();
	subscriber.on('error', err => console.error('[message] redis fanout subscriber error:', err.message));
	subscriber.subscribe(MESSAGE_FANOUT_CHANNEL).catch(err => {
		console.error('[message] redis fanout subscribe failed:', err.message);
	});
	subscriber.on('message', (_channel, raw) => {
		try {
			const payload = JSON.parse(raw) as FanoutPayload;
			if (!payload || payload.instanceId === INSTANCE_ID || !payload.room || !payload.message) return;
			sendLocalRoom(payload.room, payload.message);
		} catch (err: unknown) {
			const messageText = err instanceof Error ? err.message : String(err);
			console.error('[message] redis fanout parse failed:', messageText);
		}
	});
};

subscribeRoomFanout();

const parseIncomingMessage = (data: RawData): IncomingMessage | null => {
	try {
		const raw = Array.isArray(data)
			? Buffer.concat(data).toString('utf8')
			: Buffer.isBuffer(data)
				? data.toString('utf8')
				: Buffer.from(new Uint8Array(data)).toString('utf8');
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value) || typeof value.content !== 'string') return null;
		return {
			content: value.content,
			type: value.type,
			fileSize: value.fileSize,
			clientMsgId: value.clientMsgId
		};
	} catch {
		return null;
	}
};

const normalizeClientMsgId = (value: unknown): string | null => {
	if (typeof value !== 'string') return null;
	const text = value.trim();
	return /^[a-zA-Z0-9_-]{8,64}$/.test(text) ? text : null;
};

const getWsToken = (req: Request, params: URLSearchParams): string => {
	const protocols = String(req.headers['sec-websocket-protocol'] || '')
		.split(',')
		.map(item => item.trim())
		.filter(Boolean);
	const protocolToken = protocols.find(item => item !== 'pomelo-token');
	return protocolToken || params.get('token') || '';
};

const authorizeChatRoom = async (userId: UserId, room: string, type: ChatType) => {
	if (type === 'group') {
		const rows = await Query<GroupMembershipRow[]>(
			`SELECT gc.id FROM group_chat gc JOIN group_members gm ON gm.group_id = gc.id WHERE gc.room = ? AND gm.user_id = ? LIMIT 1`,
			[room, userId]
		);
		return rows.length ? { receiverId: rows[0].id } : null;
	}
	const rows = await Query<FriendMembershipRow[]>(
		`SELECT f.user_id FROM friend f JOIN friend_group fg ON fg.id = f.group_id WHERE f.room = ? AND fg.user_id = ? LIMIT 1`,
		[room, userId]
	);
	return rows.length ? { receiverId: rows[0].user_id } : null;
};

const ensureConversation = async (
	query: <T>(sql: string, info?: unknown) => Promise<T>,
	room: string,
	type: ChatType,
	targetId: number
): Promise<ConversationRow> => {
	await query(`INSERT IGNORE INTO conversation (room, type, target_id) VALUES (?, ?, ?)`, [
		room,
		type,
		targetId
	]);
	const rows = await query<ConversationRow[]>(`SELECT id, last_seq FROM conversation WHERE room = ? FOR UPDATE`, [room]);
	if (!rows.length) throw new Error('Conversation not found');
	const nextSeq = Number(rows[0].last_seq || 0) + 1;
	await query(`UPDATE conversation SET last_seq = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
		nextSeq,
		rows[0].id
	]);
	return { id: rows[0].id, last_seq: nextSeq };
};

const touchMessageStatistics = async (room: string): Promise<void> => {
	await Query(`INSERT IGNORE INTO message_statistics (room, total) VALUES (?, 0)`, [room]);
	await Query(`UPDATE message_statistics SET total = total + 1 WHERE room = ?`, [room]);
};

const formatHistoryMessages = (rows: HistoryMessageRow[]) =>
	rows.map(item => ({
		id: item.id,
		client_msg_id: item.client_msg_id,
		room_seq: Number(item.room_seq || item.id),
		sender_id: item.sender_id,
		receiver_id: item.receiver_id,
		content: item.content,
		room: item.room,
		avatar: item.avatar,
		type: item.media_type,
		file_size: formatBytes(item.file_size),
		created_at: new Date(item.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
	}));

const fetchHistoryMessages = async (
	userId: UserId,
	room: string,
	type: ChatType,
	beforeId?: number,
	limit = HISTORY_PAGE_SIZE
) => {
	const authorized = await authorizeChatRoom(userId, room, type);
	if (!authorized) return null;
	const safeLimit = Math.max(1, Math.min(Number(limit) || HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE));
	const hasCursor = Number.isInteger(beforeId) && Number(beforeId) > 0;
	const sql = `
		SELECT page.*, u.avatar
		FROM (
			SELECT
				id,
				client_msg_id,
				CASE WHEN room_seq = 0 THEN id ELSE room_seq END AS room_seq,
				sender_id,
				receiver_id,
				content,
				room,
				media_type,
				file_size,
				created_at
			FROM message
			WHERE room = ? AND type = ? ${hasCursor ? 'AND id < ?' : ''}
			ORDER BY id DESC
			LIMIT ?
		) AS page
		LEFT JOIN user AS u ON u.id = page.sender_id
		ORDER BY page.id ASC
	`;
	const params = hasCursor ? [room, type, beforeId, safeLimit] : [room, type, safeLimit];
	const rows = await Query<HistoryMessageRow[]>(sql, params);
	return {
		authorized,
		messages: formatHistoryMessages(rows),
		hasMore: rows.length === safeLimit,
		nextBeforeId: rows[0]?.id
	};
};

const markRoomRead = async (userId: UserId, room: string, type: ChatType, roomSeq?: number): Promise<void> => {
	await Query(`UPDATE message SET status = 1 WHERE receiver_id = ? AND room = ? AND type = ? AND status = 0`, [
		userId,
		room,
		type
	]);
	const hasExplicitSeq = Number.isFinite(roomSeq) && Number(roomSeq) > 0;
	await Query(
		`INSERT INTO conversation_read (conversation_id, user_id, last_read_seq)
		 SELECT c.id, ?, ${hasExplicitSeq ? '?' : 'c.last_seq'} FROM conversation c WHERE c.room = ?
		 ON DUPLICATE KEY UPDATE last_read_seq = VALUES(last_read_seq), updated_at = CURRENT_TIMESTAMP`,
		hasExplicitSeq ? [userId, roomSeq, room] : [userId, room]
	);
};

const writeAndSend = async (
	type: ChatType,
	room: string,
	msg: InsertMessage,
	message: OutboundMessage
): Promise<OutboundMessage> => {
	msg.status = type === 'group' || (type === 'private' && !!ChatRooms[room]?.[String(message.receiver_id)]) ? 1 : 0;
	const saved = await withTransaction(async query => {
		if (msg.client_msg_id) {
			const existing = await query<HistoryMessageRow[]>(
				`SELECT id, client_msg_id, room_seq, sender_id, receiver_id, content, room, media_type, file_size, created_at, NULL AS avatar
				 FROM message WHERE sender_id = ? AND client_msg_id = ? LIMIT 1`,
				[msg.sender_id, msg.client_msg_id]
			);
			if (existing.length) return { row: existing[0], inserted: false };
		}
		const conversation = await ensureConversation(query, room, type, Number(message.receiver_id));
		msg.conversation_id = conversation.id;
		msg.room_seq = conversation.last_seq;
		const result = await query<WriteResult>(`INSERT INTO message SET ?`, msg);
		await query(`UPDATE conversation SET last_message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
			result.insertId,
			conversation.id
		]);
		return {
			row: {
			id: result.insertId,
			client_msg_id: msg.client_msg_id || null,
			room_seq: msg.room_seq || result.insertId,
			sender_id: msg.sender_id,
			receiver_id: msg.receiver_id,
			content: msg.content,
			room: msg.room,
			media_type: msg.media_type,
			file_size: msg.file_size,
			created_at: new Date(),
			avatar: null
			} as HistoryMessageRow,
			inserted: true
		};
	});
	if (saved.inserted) await touchMessageStatistics(room);

	const outbound: OutboundMessage = {
		...message,
		id: saved.row.id,
		client_msg_id: saved.row.client_msg_id,
		room_seq: Number(saved.row.room_seq || saved.row.id),
		created_at: new Date(saved.row.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
		file_size: formatBytes(msg.file_size)
	};

	if (saved.inserted) {
		sendLocalRoom(room, outbound);
		await publishRoomMessage(room, outbound);
		if (type === 'group') {
			const results = await Query<GroupMemberRow[]>(`SELECT user_id FROM group_members WHERE group_id = ?`, [
				message.receiver_id
			]);
			for (const item of results) {
				if (item.user_id !== message.sender_id) NotificationUser({ receiver_id: item.user_id, name: 'chatList' });
			}
		} else {
			NotificationUser({ receiver_id: message.receiver_id, name: 'chatList' });
		}
	}
	return outbound;
};

export const sendConfirmedTextMessage = async (
	userId: number,
	room: string,
	type: ChatType,
	content: string
): Promise<void> => {
	if (!room || !content.trim() || content.length > MAX_MESSAGE_LENGTH) throw new Error('Invalid message');
	const authorized = await authorizeChatRoom(userId, room, type);
	if (!authorized) throw new Error('Room access denied');
	await writeAndSend(
		type,
		room,
		{
			sender_id: userId,
			receiver_id: authorized.receiverId,
			content: content.trim(),
			room,
			type,
			media_type: 'text',
			file_size: 0,
			status: 0,
			client_msg_id: null
		},
		{ sender_id: userId, receiver_id: authorized.receiverId, content: content.trim(), room, type: 'text', file_size: 0 }
	);
};

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
	const type = typeof req.query.type === 'string' && isChatType(req.query.type) ? req.query.type : null;
	const beforeId = req.query.beforeId ? Number(req.query.beforeId) : undefined;
	const limit = req.query.limit ? Number(req.query.limit) : HISTORY_PAGE_SIZE;
	if (!room || !type) return RespError(res, CommonStatus.PARAM_ERR);
	try {
		const result = await fetchHistoryMessages(req.user!.id, room, type, Number.isFinite(beforeId) ? beforeId : undefined, limit);
		if (!result) return RespError(res, CommonStatus.TOKEN_ERR);
		RespData(res, { messages: result.messages, hasMore: result.hasMore, nextBeforeId: result.nextBeforeId });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[message] getHistory error:', message);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

export const markRead = async (req: Request, res: Response): Promise<void> => {
	const room = typeof req.body?.room === 'string' ? req.body.room : '';
	const type = typeof req.body?.type === 'string' && isChatType(req.body.type) ? req.body.type : null;
	const roomSeq = req.body?.roomSeq ? Number(req.body.roomSeq) : undefined;
	if (!room || !type) return RespError(res, CommonStatus.PARAM_ERR);
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

export const connectChat = async (ws: WebSocket, req: Request): Promise<void> => {
	const params = new URLSearchParams(req.url!.split('?')[1]);
	const room = params.get('room') || '';
	const id = params.get('id') || '';
	const type = params.get('type') || '';
	const token = getWsToken(req, params);
	const decoded = await verifyTokenWithSession(token);
	if (!decoded || String(decoded.id) !== String(id)) {
		ws.send(JSON.stringify({ name: 'error', message: 'unauthorized' }));
		ws.close(4001, 'unauthorized');
		return;
	}
	if (!(room && id && isChatType(type))) {
		ws.send(JSON.stringify({ name: 'error', message: 'invalid room params' }));
		ws.close(4002, 'bad request');
		return;
	}
	try {
		const authorized = await authorizeChatRoom(decoded.id as UserId, room, type);
		if (!authorized) {
			ws.send(JSON.stringify({ name: 'error', message: 'forbidden' }));
			ws.close(4003, 'forbidden');
			return;
		}
		ChatRooms[room] ||= {};
		ChatRooms[room][id] = ws;
		const history = await fetchHistoryMessages(decoded.id as UserId, room, type, undefined, HISTORY_PAGE_SIZE);
		ws.send(JSON.stringify({ name: 'history', messages: history?.messages || [], hasMore: history?.hasMore, nextBeforeId: history?.nextBeforeId }));
		await markRoomRead(id, room, type);

		ws.on('message', async (data: RawData) => {
			try {
				const message = parseIncomingMessage(data);
				if (!message || !message.content.trim() || message.content.length > MAX_MESSAGE_LENGTH) {
					ws.send(JSON.stringify({ name: 'error', message: 'invalid message' }));
					return;
				}
				const mediaType = isMediaType(message.type) ? message.type : 'text';
				const clientMsgId = normalizeClientMsgId(message.clientMsgId);
				const outbound = await writeAndSend(
					type,
					room,
					{
						sender_id: decoded.id as UserId,
						receiver_id: authorized.receiverId,
						content: message.content,
						room,
						type,
						media_type: mediaType,
						file_size: Number.isFinite(Number(message.fileSize)) ? Number(message.fileSize) : 0,
						status: 0,
						client_msg_id: clientMsgId
					},
					{
						sender_id: decoded.id as UserId,
						receiver_id: authorized.receiverId,
						content: message.content,
						room,
						type: mediaType,
						file_size: Number.isFinite(Number(message.fileSize)) ? Number(message.fileSize) : 0
					}
				);
				ws.send(JSON.stringify({ name: 'ack', id: outbound.id, client_msg_id: outbound.client_msg_id, room_seq: outbound.room_seq }));
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				console.error('[message] ws message error:', message);
				ws.send(JSON.stringify({ name: 'error', message: 'message send failed' }));
			}
		});
		ws.on('close', () => {
			if (ChatRooms[room]?.[id]) delete ChatRooms[room][id];
		});
		ws.on('error', (err: Error) => {
			console.error(`[message] ws error room=${room} id=${id}:`, err.message);
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[message] connectChat error:', message);
		ws.send(JSON.stringify({ name: 'error', message: 'message channel failed' }));
		ws.close();
	}
};
