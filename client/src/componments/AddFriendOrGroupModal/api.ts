import { IFriendItem, IAddFriendParams, IGroupItem, IAddGroupParams } from './type';

import Request from '@/utils/request';

/**
 * 模糊查询符合条件的用户
 * @param username 用户名
 * @returns 符合条件的用户列表
 */
export const getFriendList = async (username: string) => {
	const res = await Request.get<IFriendItem[]>(`/friend/search_user?username=${username}`);
	return res.data;
};
/**
 * 加好友
 * @param data 加好友参数
 * @returns 响应数据
 */
export const addFriend = async (data: IAddFriendParams) => {
	const res = await Request.post<IAddFriendParams>(`/friend/add_friend`, data);
	return res.data;
};
/**
 * 模糊查询符合条件的群
 * @param group_name 群名称
 * @returns 符合条件的群列表
 */
export const getGroupList = async (group_name: string) => {
	const res = await Request.get<IGroupItem[]>(`/friend/search_group?name=${group_name}`);
	return res.data;
};
/**
 * 加群
 * @param data 加群参数
 * @returns 响应数据
 */
export const addGroup = async (data: IAddGroupParams) => {
	const res = await Request.post<IAddGroupParams>(`/group/add_group`, data);
	return res.data;
};