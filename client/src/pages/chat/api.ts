import { IMessageListItem } from '@/components/ChatTool/type';
import { IMessageItem } from '@/components/MessageShow/type';
import Request from '@/utils/request';

// 获取消息列表
export const getChatList = async () => {
	const res = await Request.get<IMessageListItem[]>(`message/chat_list`);
	return res.data;
};

export const getChatHistory = async (params: {
	room: string;
	type: 'private' | 'group';
	beforeId?: number;
	limit?: number;
}) => {
	const res = await Request.get<{
		messages: IMessageItem[];
		hasMore: boolean;
		nextBeforeId?: number;
	}>('message/history', { params });
	return res.data;
};

export const markChatRead = async (data: {
	room: string;
	type: 'private' | 'group';
	roomSeq?: number;
}) => {
	const res = await Request.post<typeof data, { room: string; read: boolean; roomSeq?: number }>('message/read', data);
	return res.data;
};
