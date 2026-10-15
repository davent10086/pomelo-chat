import { useCallback, useEffect, useRef, useState } from 'react';
import type { IMessageItem } from '@/components/MessageShow/type';
import { requestReplySuggestions } from '@/utils/assistant';

const fallbackReplies = (text: string, seed: number) => {
	const replies = [
		'收到，我先核对细节，再给你反馈。',
		'我先整理一个要点清单，稍后发你确认。',
		'请补充相关资料，我来评估下一步。',
		'我们先对齐范围和时间，再开始推进。',
		'我来跟进，有结果及时同步。'
	];
	if (/[?？]|吗|是否|怎么|如何/.test(text)) replies[0] = '我先核对这个问题，稍后给你明确答复。';
	const offset = seed % replies.length;
	return [...replies.slice(offset), ...replies.slice(0, offset)];
};

/** Both suggestion surfaces share cancellation, context limits and local fallback. */
export function useReplySuggestions(
	messages: IMessageItem[],
	{
		scope,
		count = 5,
		maxLength = 50,
		debounceMs
	}: {
		scope: string;
		count?: number;
		maxLength?: number;
		debounceMs?: number;
	}
) {
	const [suggestions, setSuggestions] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const current = useRef<AbortController>();
	const sequence = useRef(0);
	const latest = useRef(messages);
	latest.current = messages;
	const cancel = useCallback(() => {
		current.current?.abort();
		current.current = undefined;
		setSuggestions([]);
		setLoading(false);
	}, []);
	useEffect(() => {
		cancel();
		return () => {
			current.current?.abort();
			current.current = undefined;
		};
	}, [scope, cancel]);
	const refresh = useCallback(
		async (prefix = '') => {
			current.current?.abort();
			const controller = new AbortController();
			current.current = controller;
			const seed = sequence.current++;
			const context = latest.current
				.slice(-12)
				.map(item => `${item.sender_name || '用户'}: ${item.content || ''}`)
				.join('\n');
			setLoading(true);
			setSuggestions([]);
			try {
				let items: string[];
				try {
					items = await requestReplySuggestions(
						`根据最近对话，提供最多${count}条简短中文回复建议，每条不超过${maxLength}字，放入 replySuggestions 字段。当前输入片段：${prefix.slice(-6000)}`,
						context,
						controller.signal
					);
				} catch {
					if (controller.signal.aborted) return [];
					items = fallbackReplies(context, seed);
				}
				if (current.current !== controller || controller.signal.aborted) return [];
				const result = items.slice(0, count);
				setSuggestions(result);
				return result;
			} finally {
				if (current.current === controller) {
					current.current = undefined;
					setLoading(false);
				}
			}
		},
		[count, maxLength]
	);
	useEffect(() => {
		if (debounceMs === undefined || !messages.length) return;
		cancel();
		const timer = setTimeout(() => {
			void refresh();
		}, debounceMs);
		return () => clearTimeout(timer);
	}, [scope, messages.length, debounceMs, refresh, cancel]);
	return { suggestions, loading, refresh, cancel };
}
