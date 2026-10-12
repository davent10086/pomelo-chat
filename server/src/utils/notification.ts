import { Query } from './query';
import { validateSessionSocket } from './socket-session';
import { better_chat } from './authenticate';
import { getNotificationSocket } from './notification-connections';

const channel = `${process.env.REDIS_KEY_PREFIX || ''}pomelo:notifications`;
const instance = `${process.pid}-${Math.random()}`;
let subscriber: ReturnType<typeof better_chat.duplicate> | undefined;
const onRedisEnd = () => subscriber?.disconnect();
const sendLocal = async (username: string, data: NotificationData): Promise<void> => {
	const ws = getNotificationSocket(username);
	if (ws && (await validateSessionSocket(ws))) ws.send(JSON.stringify(data));
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

interface UserNameRow {
	username: string;
}

// 通知对方（传入receiver_username或者receiver_id）
export const NotificationUser = async (data: NotificationData): Promise<void> => {
	// 接收者
	let receiver_username = data.receiver_username;
	if (!receiver_username) {
		const sql = `SELECT username FROM user WHERE id = ?`;
		const results = await Query<UserNameRow[]>(sql, [data.receiver_id]);
		receiver_username = results[0]?.username;
	}
	if (receiver_username) {
		await better_chat.publish(
			channel,
			JSON.stringify({ instance, username: receiver_username, data })
		);
		await sendLocal(receiver_username, data);
	}
};
