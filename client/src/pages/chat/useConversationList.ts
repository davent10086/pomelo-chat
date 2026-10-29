import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IMessageListItem } from '@/components/ChatTool/type';
import { AI_USERNAME } from '@/hooks/useAiAssistant';
import { getChatList } from './api';
import { CoalescedRefresh } from '@/utils/coalesced-refresh';

export function useConversationList(
	userId: number,
	avatar: string,
	onError: (message: string) => void
) {
	const [chatList, setChatList] = useState<IMessageListItem[]>([]);
	const refresher = useMemo(() => new CoalescedRefresh(
		async signal => {
			const response = await getChatList(signal);
			if (response.code !== 200) throw new Error('Unable to refresh chat list');
			return response.data;
		},
		items => {
			const assistant = items.find(
				item => item.receiver_username === AI_USERNAME || item.room.startsWith('ai_')
			) || {
				receiver_id: -100,
				receiver_username: AI_USERNAME,
				name: 'AI助手',
				room: `ai_${userId}`,
				updated_at: new Date(),
				unreadCount: 0,
				lastMessage: '随时为你总结、规划和执行操作',
				type: 'text',
				avatar
			};
			setChatList([assistant, ...items.filter(item => item.room !== assistant.room)]);
		},
		() => onError('Unable to refresh chat list')
	), [userId, avatar, onError]);
	useEffect(() => () => refresher.cancel(), [refresher]);
	const refreshChatList = useCallback(() => refresher.refresh(), [refresher]);
	const scheduleChatListRefresh = useCallback(() => refresher.invalidate(), [refresher]);
	const ensureConversation = useCallback((item: IMessageListItem) => {
		setChatList(previous =>
			previous.some(current => current.room === item.room) ? previous : [item, ...previous]
		);
	}, []);
	const updatePreview = useCallback((room: string, text: string) => {
		setChatList(previous =>
			previous.map(item =>
				item.room === room
					? { ...item, lastMessage: text, type: 'text', updated_at: new Date() }
					: item
			)
		);
	}, []);
	return { chatList, ensureConversation, updatePreview, refreshChatList, scheduleChatListRefresh };
}
