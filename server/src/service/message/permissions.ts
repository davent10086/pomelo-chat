import { Query } from '../../utils/query';
import type { UserId, ChatType, GroupMembershipRow, FriendMembershipRow } from './contracts';
export const authorizeChatRoom = async (userId: UserId, room: string, type: ChatType) => {
	if (type === 'group') {
		const rows = await Query<GroupMembershipRow[]>(
			`SELECT gc.id FROM group_chat AS gc INNER JOIN group_members AS gm ON gm.group_id = gc.id WHERE gm.user_id = ? AND gc.room = ? LIMIT 1`,
			[userId, room]
		);
		return rows.length ? { receiverId: rows[0].id } : null;
	}
	const rows = await Query<FriendMembershipRow[]>(
		`SELECT f.user_id FROM friend AS f INNER JOIN friend_group AS fg ON fg.id = f.group_id WHERE fg.user_id = ? AND f.room = ? LIMIT 1`,
		[userId, room]
	);
	return rows.length ? { receiverId: rows[0].user_id } : null;
};

export const accessibleRoomType = async (
	userId: UserId,
	room: string
): Promise<ChatType | undefined> => {
	if (await authorizeChatRoom(userId, room, 'private')) return 'private';
	if (await authorizeChatRoom(userId, room, 'group')) return 'group';
	return undefined;
};
