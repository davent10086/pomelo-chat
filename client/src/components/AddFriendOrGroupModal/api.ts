import { IFriendItem, IAddFriendParams, IGroupItem, IAddGroupParams } from './type';

import Request from '@/utils/request';

// 模糊查询符合条件的用户
export const getFriendList = async (username: string, afterId = 0, signal?: AbortSignal) => {
	const res = await Request.get<IFriendItem[]>('/friend/search_user', {
		params: { username, afterId, limit: 30 },
		signal
	});
	return res.data;
};
// 加好友
export const addFriend = async (data: IAddFriendParams) => {
	const res = await Request.post<IAddFriendParams>(`/friend/add_friend`, data);
	return res.data;
};
// 模糊查询符合条件的群
export const getGroupList = async (name: string, afterId = 0, signal?: AbortSignal) => {
	const res = await Request.get<IGroupItem[]>('/group/search_group', {
		params: { name, afterId, limit: 30 },
		signal
	});
	return res.data;
};
// 加群
export const addGroup = async (data: IAddGroupParams) => {
	const res = await Request.post<IAddGroupParams>(`/group/add_group`, data);
	return res.data;
};
