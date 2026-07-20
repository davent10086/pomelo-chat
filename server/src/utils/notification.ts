import { Query } from './query';

interface NotificationData {
	receiver_username?: string;
	receiver_id?: number | string;
	[name: string]: any;
}

// 通知对方（传入receiver_username或者receiver_id）
export const NotificationUser = async (data: NotificationData): Promise<void> => {
	// 接收者
	let receiver_username = data.receiver_username;
	if (!receiver_username) {
		const sql = `SELECT username FROM user WHERE id = ?`;
		const results: any = await Query(sql, [data.receiver_id]);
		receiver_username = results[0].username;
	}
	if (LoginRooms[receiver_username!]) {
		LoginRooms[receiver_username!].ws.send(JSON.stringify(data));
	}
};
