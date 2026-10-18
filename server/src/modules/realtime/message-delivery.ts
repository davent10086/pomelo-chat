import * as readModel from '../../read-models/realtime';
import type { WebSocket } from 'ws';
import { better_chat } from '../../infrastructure/redis';
import { validateSessionSocket } from './session-sockets';
import { authorizeChatRoom } from '../social/public';
import { NotificationUser } from './notification';
import { sendSocketFrame } from './socket-send';
import {
	trackDelivery,
	startDeliveryObservation,
	stopDeliveryObservation
} from './delivery-observation';
import { forEachConcurrent } from '../../shared/parallel';
import { startMessageOutbox, stopMessageOutbox, enableMessageOutbox } from '../messaging/public';
import { formatHistoryMessages } from '../messaging/public';
import type {
	FanoutPayload,
	OutboundMessage,
	HistoryMessageRow,
	ChatType
} from '../messaging/contracts';
import type { ReadReceiptFrame } from '../messaging/contracts';
export const ChatRooms: Record<string, Record<string, WebSocket>> = {};
const MESSAGE_FANOUT_CHANNEL = `${process.env.REDIS_KEY_PREFIX || ''}pomelo:message:fanout`;
const INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let subscriber: ReturnType<typeof better_chat.duplicate> | undefined;
const onRedisEnd = () => subscriber?.disconnect();
export const sendFrame = (ws: WebSocket, frame: unknown): void => {
	if (ws.readyState !== 1) return;
	try {
		sendSocketFrame(ws, frame);
	} catch (err) {
		console.error('[message] frame send failed:', err);
	}
};

export const sendLocalRoom = async (
	room: string,
	message: OutboundMessage | ReadReceiptFrame,
	persistedAt?: number
): Promise<void> => {
	await forEachConcurrent(Object.entries(ChatRooms[room] || {}), 16, async ([key, ws]) => {
		try {
			if (!(await validateSessionSocket(ws))) return;
			if (
				'name' in message &&
				message.name === 'read_receipt' &&
				!(await authorizeChatRoom(key.split(':')[0], room, 'private'))
			)
				return;
			const receipt =
				!('name' in message) && message.id && String(message.sender_id) !== key.split(':')[0]
					? trackDelivery(ws, persistedAt)
					: undefined;
			sendFrame(ws, receipt ? { ...message, receipt } : message);
		} catch (err: unknown) {
			const messageText = err instanceof Error ? err.message : String(err);
			console.error('[message] send failed room=%s key=%s: %s', room, key, messageText);
		}
	});
};

const publishRoomMessage = async (
	room: string,
	message: OutboundMessage | ReadReceiptFrame,
	persistedAt?: number
): Promise<void> => {
	await better_chat.publish(
		MESSAGE_FANOUT_CHANNEL,
		JSON.stringify({ instanceId: INSTANCE_ID, room, message, persistedAt })
	);
};

export const publishReadReceipt = async (frame: ReadReceiptFrame): Promise<void> => {
	await sendLocalRoom(frame.room, frame);
	await publishRoomMessage(frame.room, frame);
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
			void sendLocalRoom(payload.room, payload.message, payload.persistedAt).catch(err =>
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
	startDeliveryObservation();
	startMessageOutbox(async id => {
		const rows = await readModel.loadMessageForDelivery<
			HistoryMessageRow[] & Array<{ type: ChatType }>
		>([id]);
		if (!rows.length) return;
		const row = rows[0];
		const outbound = formatHistoryMessages(rows)[0];
		const persistedAt = new Date(row.created_at).getTime();
		await publishRoomMessage(row.room, outbound, persistedAt);
		await sendLocalRoom(row.room, outbound, persistedAt);
		if (row.type === 'group') {
			const members = await readModel.listGroupDeliveryRecipients<Array<{ username: string }>>([
				row.receiver_id,
				row.sender_id
			]);
			await forEachConcurrent(members, 16, m =>
				NotificationUser({ receiver_username: m.username, name: 'chatList' })
			);
		} else await NotificationUser({ receiver_id: row.receiver_id, name: 'chatList' });
	});

	enableMessageOutbox();
};
export const stopMessageDelivery = async () => {
	await stopMessageOutbox();
	stopDeliveryObservation();
	better_chat.off('end', onRedisEnd);
	subscriber?.disconnect();
	subscriber = undefined;
};
