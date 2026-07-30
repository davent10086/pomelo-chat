import { Query } from './query';

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
	if (receiver_username && LoginRooms[receiver_username]) {
		LoginRooms[receiver_username].ws.send(JSON.stringify(data));
	}
};
