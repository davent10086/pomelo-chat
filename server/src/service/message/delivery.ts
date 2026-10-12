import type { WebSocket } from 'ws';
import { better_chat } from '../../utils/authenticate';
import { validateSessionSocket } from '../../utils/socket-session';
import { Query } from '../../utils/query';
import { NotificationUser } from '../../utils/notification';
import { startMessageOutbox, stopMessageOutbox, enableMessageOutbox } from './outbox';
import { formatHistoryMessages } from './queries';
import type {
	FanoutPayload,
	OutboundMessage,
	HistoryMessageRow,
	ChatType,
	GroupMemberRow
} from './contracts';
export const ChatRooms: Record<string, Record<string, WebSocket>> = {};
const MESSAGE_FANOUT_CHANNEL = `${process.env.REDIS_KEY_PREFIX || ''}pomelo:message:fanout`;
const INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let subscriber: ReturnType<typeof better_chat.duplicate> | undefined;
const onRedisEnd = () => subscriber?.disconnect();
export const sendFrame = (ws: WebSocket, frame: unknown): void => {
	if (ws.readyState !== 1) return;
	try {
		ws.send(JSON.stringify(frame));
	} catch (err) {
		console.error('[message] frame send failed:', err);
	}
};

export const sendLocalRoom = async (room: string, message: OutboundMessage): Promise<void> => {
	for (const key in ChatRooms[room] || {}) {
		try {
			const ws = ChatRooms[room][key];
			if (await validateSessionSocket(ws)) ws.send(JSON.stringify(message));
		} catch (err: unknown) {
			const messageText = err instanceof Error ? err.message : String(err);
			console.error('[message] send failed room=%s key=%s: %s', room, key, messageText);
		}
	}
};

const publishRoomMessage = async (room: string, message: OutboundMessage): Promise<void> => {
	await better_chat.publish(
		MESSAGE_FANOUT_CHANNEL,
		JSON.stringify({ instanceId: INSTANCE_ID, room, message })
	);
};

export const subscribeRoomFanout = async (): Promise<void> => {
	if (subscriber) return;
	subscriber = better_chat.duplicate();
	better_chat.on('end', onRedisEnd);
	subscriber.on('error', err =>
		console.error('[message] redis fanout subscriber error:', err.message)
	);
	subscriber.on('ready', () => {
		void (async () => {
			for (const room of Object.values(ChatRooms)) {
				for (const ws of Object.values(room)) {
					if (await validateSessionSocket(ws)) sendFrame(ws, { name: 'resync' });
				}
			}
		})().catch(err => console.error('[message] resync failed:', err));
	});
	subscriber.on('message', (_channel, raw) => {
		try {
			const payload = JSON.parse(raw) as FanoutPayload;
			if (!payload || payload.instanceId === INSTANCE_ID || !payload.room || !payload.message)
				return;
			void sendLocalRoom(payload.room, payload.message).catch(err =>
				console.error('[message] delivery:', err)
			);
		} catch (err: unknown) {
			const messageText = err instanceof Error ? err.message : String(err);
			console.error('[message] redis fanout parse failed:', messageText);
		}
	});
	await subscriber.subscribe(MESSAGE_FANOUT_CHANNEL);
};

export const startMessageDelivery = async () => {
	await subscribeRoomFanout();
	startMessageOutbox(async id => {
		const rows = await Query<HistoryMessageRow[] & Array<{ type: ChatType }>>(
			'SELECT m.*, u.avatar FROM message m LEFT JOIN user u ON u.id = m.sender_id WHERE m.id = ?',
			[id]
		);
		if (!rows.length) return;
		const row = rows[0];
		const outbound = formatHistoryMessages(rows)[0];
		await publishRoomMessage(row.room, outbound);
		await sendLocalRoom(row.room, outbound);
		if (row.type === 'group') {
			const members = await Query<GroupMemberRow[]>(
				'SELECT user_id FROM group_members WHERE group_id = ?',
				[row.receiver_id]
			);
			await Promise.all(
				members
					.filter(m => String(m.user_id) !== String(row.sender_id))
					.map(m => NotificationUser({ receiver_id: m.user_id, name: 'chatList' }))
			);
		} else await NotificationUser({ receiver_id: row.receiver_id, name: 'chatList' });
	});

	enableMessageOutbox();
};
export const stopMessageDelivery = async () => {
	await stopMessageOutbox();
	better_chat.off('end', onRedisEnd);
	subscriber?.disconnect();
	subscriber = undefined;
};
