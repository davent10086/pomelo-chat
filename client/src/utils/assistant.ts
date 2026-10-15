import type { AgentEvent, AgentResponse } from '@/hooks/useAiAssistant';
import { apiBaseURL } from '@/config';
import { sanitizeAiContent } from '@/utils/sanitize';
import { tokenStorage } from '@/utils/storage';
import request from '@/utils/request';
import { invalidateDesktopAuth } from '@/desktop/bridge';

export const requestAgentReply = async (
	input: string,
	context: Record<string, unknown>,
	signal?: AbortSignal,
	room?: string
): Promise<AgentResponse> => {
	const response = await request.post<
		{ input: string; room?: string; context: Record<string, unknown> },
		AgentResponse
	>('/assistant/agent', { input, room, context }, { signal });
	if (!response.data.data?.content) throw new Error('AI 本次没有生成可用回答。');
	return response.data.data;
};

export const requestReplySuggestions = async (
	input: string,
	recentMessagesText: string,
	signal?: AbortSignal
): Promise<string[]> => {
	const result = await requestAgentReply(
		input,
		{
			currentChatType: 'assistant',
			recentMessagesText: recentMessagesText.slice(-20000),
			memoryEnabled: false,
			readOnly: true
		},
		signal
	);
	return (result.replySuggestions || [])
		.filter(item => typeof item === 'string' && item.trim())
		.map(sanitizeAiContent)
		.slice(0, 5);
};

export const streamAgentReply = async (
	input: string,
	room: string | undefined,
	context: Record<string, unknown>,
	onDelta: (text: string) => void,
	onEvent?: (event: AgentEvent) => void,
	signal?: AbortSignal
): Promise<AgentResponse> => {
	const requestToken = tokenStorage.getItem();
	const response = await fetch(`${apiBaseURL}/assistant/agent/stream`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${requestToken}` },
		body: JSON.stringify({ input, room, context }),
		signal
	});
	if (response.status === 401 && tokenStorage.getItem() === requestToken)
		invalidateDesktopAuth(requestToken);
	if (!response.ok || !response.body)
		throw new Error(
			response.status === 403
				? '没有权限访问该会话。'
				: response.status === 401
					? '登录已失效，请在主窗口重新登录。'
					: 'AI 服务连接失败，请稍后重试。'
		);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let text = '';
	let result: AgentResponse | undefined;
	const handleEvent = (frame: string) => {
		const event = frame.match(/^event: (.+)$/m)?.[1];
		const data = frame
			.split('\n')
			.filter(line => line.startsWith('data: '))
			.map(line => line.slice(6))
			.join('\n');
		if (!data || data === '[DONE]') return;
		if (event === 'agent') {
			onEvent?.(JSON.parse(data) as AgentEvent);
			return;
		}
		const value = JSON.parse(data) as AgentResponse & {
			delta?: string;
			reset?: boolean;
			error?: string;
		};
		if (event === 'delta' && typeof value.delta === 'string') {
			if (value.reset) text = '';
			text += value.delta;
			onDelta(sanitizeAiContent(text));
		} else if (value.error) {
			throw new Error(value.error);
		} else if (typeof value.content === 'string') {
			result = value;
		}
	};
	try {
		while (!signal?.aborted) {
			const { value, done } = await reader.read();
			if (value)
				buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
			let boundary = buffer.indexOf('\n\n');
			while (boundary >= 0) {
				handleEvent(buffer.slice(0, boundary));
				buffer = buffer.slice(boundary + 2);
				boundary = buffer.indexOf('\n\n');
			}
			if (done) break;
		}
		if (buffer.trim()) handleEvent(buffer);
		if (signal?.aborted) throw new DOMException('Generation stopped', 'AbortError');
		if (!result) throw new Error('AI 回答中断，请重试。');
		return result;
	} finally {
		reader.releaseLock();
	}
};
