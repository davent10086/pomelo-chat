import * as readModel from '../../read-models/realtime';
import type { WebSocket } from 'ws';
import { better_chat } from '../../infrastructure/redis';
import { validateSessionSocket } from './session-sockets';
import { authorizeChatRoom } from '../social/public';
import { NotificationUser } from './notification';
import { sendSocketFrame } from './socket-send';
import { fanoutPublisher, publishFanout } from './fanout-publisher';
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
	ChatType,
	UserId,
	OutboxDeliveryContext
} from '../messaging/contracts';
import type { ReadReceiptFrame } from '../messaging/contracts';
export const ChatRooms: Record<
	string,
	Record<string, { ws: WebSocket; userId: UserId; type: ChatType }>
> = {};
const lastDeliveredSequence = new WeakMap<WebSocket, number>();
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
	persistedAt?: number,
	checkActive: () => void = () => undefined
): Promise<void> => {
	await forEachConcurrent(
		Object.entries(ChatRooms[room] || {}),
		16,
		async ([key, subscription]) => {
			const { ws, userId, type } = subscription;
			try {
				checkActive();
				if (!(await validateSessionSocket(ws))) return;
				checkActive();
				if ('name' in message && type !== 'private') return;
				if (!(await authorizeChatRoom(userId, room, type))) {
					if (ChatRooms[room]?.[key] === subscription) {
						delete ChatRooms[room][key];
						if (!Object.keys(ChatRooms[room]).length) delete ChatRooms[room];
					}
					if (ws.readyState < 2) ws.close(4003, 'room access revoked');
					return;
				}
				checkActive();
				if (ws.readyState !== 1) return;
				const sequence = !('name' in message) ? message.room_seq : undefined;
				if (sequence !== undefined && sequence <= (lastDeliveredSequence.get(ws) || 0)) return;
				const receipt =
					!('name' in message) && message.id && String(message.sender_id) !== String(userId)
						? trackDelivery(ws, persistedAt)
						: undefined;
				sendFrame(ws, receipt ? { ...message, receipt } : message);
				if (sequence !== undefined) lastDeliveredSequence.set(ws, sequence);
			} catch (err: unknown) {
				const messageText = err instanceof Error ? err.message : String(err);
				console.error('[message] send failed room=%s key=%s: %s', room, key, messageText);
				try {
					checkActive();
				} catch {
					return;
				}
				// Fail closed, but force history recovery even if this was the last message.
				if (ws.readyState < 2) ws.close(1013, 'room authorization unavailable');
			}
		}
	);
};

const publishRoomMessage = async (
	room: string,
	message: OutboundMessage | ReadReceiptFrame,
	persistedAt?: number
): Promise<boolean> =>
	publishFanout(MESSAGE_FANOUT_CHANNEL, { instanceId: INSTANCE_ID, room, message, persistedAt });

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
				for (const { ws } of Object.values(room)) {
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
	if (fanoutPublisher.status === 'wait' || fanoutPublisher.status === 'end')
		await fanoutPublisher.connect();
	await subscribeRoomFanout();
	startDeliveryObservation();
	startMessageOutbox(async (id, context: OutboxDeliveryContext) => {
		const rows = await readModel.loadMessageForDelivery<
			HistoryMessageRow[] & Array<{ type: ChatType }>
		>([id]);
		if (!rows.length) return;
		const row = rows[0];
		const outbound = formatHistoryMessages(rows)[0];
		const persistedAt = new Date(row.created_at).getTime();
		await context.assertLease();
		if (!(await publishRoomMessage(row.room, outbound, persistedAt))) return;
		await context.assertLease();
		await sendLocalRoom(row.room, outbound, persistedAt, context.checkActive);
		await context.assertLease();
		if (row.type === 'group') {
			const members = await readModel.listGroupDeliveryRecipients<Array<{ username: string }>>([
				row.receiver_id,
				row.sender_id
			]);
			await forEachConcurrent(members, 16, m =>
				NotificationUser({ receiver_username: m.username, name: 'chatList' }, context.checkActive)
			);
		} else
			await NotificationUser(
				{ receiver_id: row.receiver_id, name: 'chatList' },
				context.checkActive
			);
	});

	enableMessageOutbox();
};
export const stopMessageDelivery = async () => {
	await stopMessageOutbox();
	stopDeliveryObservation();
	better_chat.off('end', onRedisEnd);
	subscriber?.disconnect();
	subscriber = undefined;
	fanoutPublisher.disconnect();
};
