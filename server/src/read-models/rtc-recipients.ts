import { Query } from '../infrastructure/database-query';
type ChatType = 'private' | 'group';
interface RtcRecipient {
	username: string;
	avatar?: string | null;
	alias?: string | null;
}
export const getRtcRecipients = async (
	userId: number | string,
	room: string,
	type: ChatType
): Promise<RtcRecipient[]> => {
	const sql =
		type === 'group'
			? 'SELECT u.username, u.avatar, u.name AS alias FROM group_chat gc JOIN group_members gm ON gm.group_id = gc.id JOIN user u ON u.id = gm.user_id WHERE gc.room = ? AND gm.user_id <> ?'
			: 'SELECT u.username, u.avatar, f.remark AS alias FROM friend f JOIN friend_group fg ON fg.id = f.group_id JOIN user u ON u.username = f.username WHERE f.room = ? AND fg.user_id = ?';
	return Query<RtcRecipient[]>(sql, [room, userId]);
};
