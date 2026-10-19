import { getUsernameById } from '../identity/public';
import { validateSessionSocket } from './session-sockets';
import { better_chat } from '../../infrastructure/redis';
import { getNotificationSocket } from './connections';
import { sendSocketFrame } from './socket-send';
import { fanoutPublisher } from './fanout-publisher';

const channel = `${process.env.REDIS_KEY_PREFIX || ''}pomelo:notifications`;
const instance = `${process.pid}-${Math.random()}`;
let subscriber: ReturnType<typeof better_chat.duplicate> | undefined;
const onRedisEnd = () => subscriber?.disconnect();
const sendLocal = async (
	username: string,
	data: NotificationData,
	checkActive?: () => void
): Promise<void> => {
	const ws = getNotificationSocket(username);
	if (ws && (await validateSessionSocket(ws))) {
		checkActive?.();
		sendSocketFrame(ws, data);
	}
};
export const startNotificationDelivery = async () => {
	if (subscriber) return;
	const connection = better_chat.duplicate();
	subscriber = connection;
	better_chat.on('end', onRedisEnd);
	connection.on('error', err => console.error('[notification] subscriber:', err.message));
	connection.on('message', (_channel, raw) => {
		try {
			const event = JSON.parse(raw) as {
				instance: string;
				username: string;
				data: NotificationData;
			};
			if (event.instance !== instance)
				void sendLocal(event.username, event.data).catch(err =>
					console.error('[notification] delivery:', err)
				);
		} catch {
			console.error('[notification] invalid event');
		}
	});
	try {
		await connection.subscribe(channel);
	} catch (error) {
		stopNotificationDelivery();
		throw error;
	}
};
export const stopNotificationDelivery = () => {
	better_chat.off('end', onRedisEnd);
	subscriber?.disconnect();
	subscriber = undefined;
};

interface NotificationData {
	receiver_username?: string;
	receiver_id?: number | string;
	[name: string]: unknown;
}

// 通知对方（传入receiver_username或者receiver_id）
export const NotificationUser = async (
	data: NotificationData,
	checkActive?: () => void
): Promise<void> => {
	// 接收者
	let receiver_username = data.receiver_username;
	if (!receiver_username) {
		receiver_username =
			data.receiver_id === undefined ? undefined : await getUsernameById(data.receiver_id);
	}
	if (receiver_username) {
		checkActive?.();
		const publisher = checkActive ? fanoutPublisher : better_chat;
		if (checkActive && publisher.status !== 'ready')
			throw new Error('Message publisher unavailable');
		await publisher.publish(
			channel,
			JSON.stringify({ instance, username: receiver_username, data })
		);
		checkActive?.();
		await sendLocal(receiver_username, data, checkActive);
	}
};
