import * as readModel from '../../read-models/social';
export interface ContactRow {
	user_id: number;
	username: string;
	remark: string | null;
	room: string;
	name: string | null;
	signature: string | null;
}
export interface GroupRow {
	id: number;
	name: string;
	room: string;
	announcement: string | null;
}
export const resolveMessageRecipient = async (
	userId: number,
	room: string,
	chatType: 'private' | 'group'
) => {
	const rows = await readModel.findMessageRecipient<
		Array<{ receiverId: number; name: string; username: string | null }>
	>(userId, room, chatType);
	return rows.length ? { ...rows[0], room, chatType } : null;
};
export const searchVisibleContacts = (userId: number, term: string): Promise<ContactRow[]> => {
	const keyword = `%${term}%`;
	return readModel.searchOwnedContactDirectory<ContactRow[]>([userId, keyword, keyword, keyword]);
};
export const searchJoinedGroups = (userId: number, term: string): Promise<GroupRow[]> =>
	readModel.searchJoinedGroupDirectory<GroupRow[]>([userId, `%${term}%`]);
