import { useCallback, useEffect, useRef, useState } from 'react';
import type { IMessageListItem } from '@/components/ChatTool/type';
import { AI_USERNAME } from '@/hooks/useAiAssistant';
import { getChatList } from './api';

export function useConversationList(
	userId: number,
	avatar: string,
	onError: (message: string) => void
) {
	const [chatList, setChatList] = useState<IMessageListItem[]>([]);
	const controller = useRef<AbortController>();
	const revision = useRef(0);
	useEffect(
		() => () => {
			revision.current++;
			controller.current?.abort();
		},
		[userId]
	);
	const refreshChatList = useCallback(async () => {
		controller.current?.abort();
		controller.current = new AbortController();
		const version = ++revision.current;
		try {
			const response = await getChatList(controller.current.signal);
			if (version !== revision.current) return;
			if (response.code !== 200) throw new Error('Unable to refresh chat list');
			const items = response.data;
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
			return items;
		} catch {
			if (version === revision.current) onError('Unable to refresh chat list');
		}
	}, [userId, avatar, onError]);
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
	return { chatList, ensureConversation, updatePreview, refreshChatList };
}
