import * as repository from './repository';
import type { SqlQuery } from '../../shared/actor';
type UserId = number | string;
type ChatType = 'private' | 'group';
interface GroupMembershipRow {
	id: number;
}
interface FriendMembershipRow {
	user_id: number;
}
export const authorizeChatRoom = async (userId: UserId, room: string, type: ChatType, executor?: SqlQuery) => {
	if (type === 'group') {
		const rows = await repository.findAccessibleGroupRoom<GroupMembershipRow[]>([userId, room], executor, !!executor);
		return rows.length ? { receiverId: rows[0].id } : null;
	}
	const rows = await repository.findAccessiblePrivateRoom<FriendMembershipRow[]>([userId, room], executor, !!executor);
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

export const updateContactPresence = async (
	username: string,
	status: 'online' | 'offline'
): Promise<void> => {
	await repository.updateFriendPresence([status, username]);
};
export const initializeDefaultFriendGroup = async (
	query: SqlQuery,
	userId: number,
	username: string
): Promise<void> => {
	await repository.insertDefaultFriendGroup({ user_id: userId, username, name: '我的好友' }, query);
};
