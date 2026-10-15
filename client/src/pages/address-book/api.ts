import {
	IFriendInfo,
	IFriendGroupListItem,
	IUpdateFriendInfo,
	ICreateFriendGroup,
	IGroupChatItem
} from './type';

import { IFriendGroupItem, IGroupChatInfo } from '@/components/CreateGroupChatModal/type';
import Request from '@/utils/request';

// 获取好友列表
export const getFriendList = async (signal?: AbortSignal) => {
	const res = await Request.get<IFriendGroupItem[]>(`friend/friend_list`, { signal });
	return res.data;
};
// 根据 id 获取好友信息
export const getFriendInfoById = async (id: number, signal?: AbortSignal) => {
	const res = await Request.get<IFriendInfo>(`friend/friend_id/?id=${id}`, { signal });
	return res.data;
};
// 获取分组列表
export const getFriendGroup = async (signal?: AbortSignal) => {
	const res = await Request.get<IFriendGroupListItem[]>(`friend/group_list`, { signal });
	return res.data;
};
// 修改好友信息
export const updateFriendInfo = async (data: IUpdateFriendInfo, signal?: AbortSignal) => {
	const res = await Request.post<IUpdateFriendInfo>(`friend/update_friend`, data, { signal });
	return res.data;
};
// 新建分组
export const createFriendGroup = async (data: ICreateFriendGroup, signal?: AbortSignal) => {
	const res = await Request.post<ICreateFriendGroup>(`friend/create_group`, data, { signal });
	return res.data;
};
// 获取群聊列表
export const getGroupChatList = async (signal?: AbortSignal) => {
	const res = await Request.get<IGroupChatItem[]>(`group/group_list`, { signal });
	return res.data;
};
// 获取群聊信息
export const getGroupChatInfo = async (group_id: number, signal?: AbortSignal) => {
	const res = await Request.get<IGroupChatInfo>(`group/group_info?group_id=${group_id}`, {
		signal
	});
	return res.data;
};
