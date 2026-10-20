import { useCallback, useEffect, useRef, useState } from 'react';
import type { IMessageItem } from '@/components/MessageShow/type';
import request from '@/utils/request';
import { mergeMessages } from '@/utils/message-merge';

interface HistoryView {
	messages: IMessageItem[];
	focusId: number;
	hasBefore: boolean;
	hasAfter: boolean;
	nextBeforeId: number;
	nextAfterId: number;
}
export const useHistoryView = (
	room: string | undefined,
	type: 'private' | 'group',
	onError: (message: string) => void
) => {
	const [view, setView] = useState<HistoryView>();
	const [loading, setLoading] = useState(false);
	const controller = useRef<AbortController>();
	const revision = useRef(0);
	const invalidate = useCallback(() => { revision.current++; controller.current?.abort(); }, []);
	const reset = useCallback(() => {
		revision.current++;
		controller.current?.abort();
		setView(undefined);
		setLoading(false);
	}, []);
	useEffect(() => {
		reset();
		return invalidate;
	}, [room, type, reset, invalidate]);
	const locate = useCallback(
		async (messageId: number) => {
			if (!room) return;
			controller.current?.abort();
			controller.current = new AbortController();
			const version = ++revision.current;
			setLoading(true);
			try {
				const res = await request.get<HistoryView>('/message/context', {
					params: { room, type, messageId },
					signal: controller.current.signal
				});
				if (version !== revision.current) return;
				if (res.data.code !== 200) throw new Error('消息不存在或无权访问');
				setView({
					...res.data.data,
					messages: res.data.data.messages.map(item => ({ ...item, status: 'sent' }))
				});
			} catch {
				if (version === revision.current) onError('无法定位消息，请重试');
			} finally {
				if (version === revision.current) setLoading(false);
			}
		},
		[room, type, onError]
	);
	const load = useCallback(
		async (direction: 'before' | 'after') => {
			if (!view || loading || !room) return;
			controller.current?.abort();
			controller.current = new AbortController();
			const version = ++revision.current;
			setLoading(true);
			try {
				const res = await request.get<{ messages: IMessageItem[]; hasMore: boolean }>(
					'/message/search',
					{
						params: {
							room,
							type,
							limit: 30,
							[direction === 'before' ? 'beforeId' : 'afterId']:
								direction === 'before' ? view.nextBeforeId : view.nextAfterId
						},
						signal: controller.current.signal
					}
				);
				if (version !== revision.current) return;
				if (res.data.code !== 200) throw new Error('无法加载历史');
				setView(previous => {
					if (!previous) return previous;
					const messages = mergeMessages(
						previous.messages,
						res.data.data.messages.map(item => ({ ...item, status: 'sent' }))
					);
					return {
						...previous,
						messages,
						nextBeforeId: messages[0].id!,
						nextAfterId: messages.at(-1)!.id!,
						[direction === 'before' ? 'hasBefore' : 'hasAfter']: res.data.data.hasMore
					};
				});
			} catch {
				if (version === revision.current) onError('加载历史消息失败');
			} finally {
				if (version === revision.current) setLoading(false);
			}
		},
		[view, loading, room, type, onError]
	);
	return { view, loading, locate, reset, load };
};
