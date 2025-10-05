import { IFriendGroupItem, ICreateGroupParams, InviteFriendsParams } from './type';

import Request from '@/utils/request';

/**
 * 获取好友列表
 * @returns 返回好友列表数据
 */
export const getFriendList = async () => {
	const res = await Request.get<IFriendGroupItem[]>(`friend/friend_list`);
	return res.data;
};

/**
 * 创建群聊
 * @param data 创建群聊所需的参数
 * @returns 返回创建群聊的结果数据
 */
export const createGroup = async (data: ICreateGroupParams) => {
	const res = await Request.post<ICreateGroupParams>(`/group/create_group`, data);
	return res.data;
};

/**
 * 邀请新的好友进入群聊
 * @param data 邀请好友所需的参数
 * @returns 返回邀请好友的结果数据
 */
export const inviteFriend = async (data: InviteFriendsParams) => {
	const res = await Request.post<InviteFriendsParams>(`/group/invite_friend`, data);
	return res.data;
};