import { useCallback, useState } from 'react';

import { IMessageItem } from '@/components/MessageShow/type';
import { apiBaseURL } from '@/config';
import { sanitizeAiContent } from '@/utils/sanitize';
import { IUserInfo, tokenStorage } from '@/utils/storage';
import request from '@/utils/request';
import { invalidateDesktopAuth } from '@/desktop/bridge';

// AI 助手用户名与头像
export const AI_USERNAME = 'ai-assistant';

export interface AgentAction {
	type: 'create_tasks' | 'send_message' | 'external_mcp' | 'save_memory' | 'forget_memory' | 'reply_suggestion';
	requiresConfirmation: boolean;
	payload: Record<string, unknown>;
	confirmationId?: string;
	expiresAt?: string;
	status?: ActionStatus['status'];
}

export interface TaskCandidate {
	title: string;
	assignee?: string;
	due?: string;
	sources: Array<{ id: number; content: string; createdAt: string }>;
}

export interface TaskCandidateResult {
	todos: TaskCandidate[];
	action: AgentAction | null;
}

export interface ActionStatus {
	confirmationId: string;
	type: string;
	status: 'pending' | 'executing' | 'completed' | 'cancelled' | 'expired';
	result?: Record<string, unknown> | null;
	retryable?: boolean;
}

export interface AgentTodo {
	title: string;
	assignee?: string;
	due?: string;
}

export interface AssistantTask {
	id: number;
	title: string;
	assignee?: string;
	due?: string;
	status: 'open' | 'completed';
	sourceRoom?: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface AgentStep {
	agent: string;
	role: 'coordinator' | 'context' | 'todo' | 'reply';
	status: 'planned' | 'success' | 'skipped' | 'error';
	detail?: string;
	tools?: string[];
	durationMs?: number;
}

export interface AgentEvent {
	type: 'agent_started' | 'agent_completed' | 'tool_started' | 'tool_completed';
	agent?: string;
	tool?: string;
	status?: 'success' | 'error';
	detail?: string;
	durationMs?: number;
}

export interface AgentResponse {
	content: string;
	summary?: string;
	todos?: AgentTodo[];
	replySuggestions?: string[];
	draftMessage?: string;
	memorySuggestion?: { content: string; category?: string };
	actions?: AgentAction[];
	toolTrace?: Array<{ tool: string; status: 'success' | 'error' }>;
	agentTrace?: string[];
	agentSteps?: AgentStep[];
}

export interface AgentReplyResult extends AgentResponse {
	text: string;
}

interface GenerateReplyOptions {
	/** Desktop callers need to distinguish failure/cancellation from successful completion. */
	throwOnError?: boolean;
	signal?: AbortSignal;
	room?: string;
	currentChatType?: string;
	currentReceiverId?: number;
	recentMessages?: IMessageItem[];
	memoryEnabled?: boolean;
	onDelta?: (text: string) => void;
	onEvent?: (event: AgentEvent) => void;
}

interface ChatResponse {
	content: string;
}

// 大模型人设提示（优先 localStorage，回退内置）
const DEFAULT_PERSONA_PROMPT = `你是一个友好、实用的AI助手。说话风格：\n1) 简洁清晰，直接回应用户问题；\n2) 口语自然，礼貌得体；\n3) 不输出不当内容；\n4) 一般不超过100字，除非用户要求详细。\n不要透露系统或你是大模型。`;

const LEGACY_PERSONA_PATTERNS = [
	/朝武芳乃/,
	/芳乃/,
	/巫女/,
	/双手交叠/,
	/轻轻低下头/,
	/Tomotake/i,
	/Yoshino/i,
	/yuzu/i
];

export const getPersonaPrompt = () => {
	if (typeof window !== 'undefined') {
		const storedPersona = localStorage.getItem('AI_PERSONA_PROMPT');
		if (storedPersona && LEGACY_PERSONA_PATTERNS.some(pattern => pattern.test(storedPersona))) {
			localStorage.removeItem('AI_PERSONA_PROMPT');
			return DEFAULT_PERSONA_PROMPT;
		}
		return storedPersona || DEFAULT_PERSONA_PROMPT;
	}
	return DEFAULT_PERSONA_PROMPT;
};

export const getAiAvatar = () => {
	if (typeof window !== 'undefined') {
		// 头像路径从环境变量读取，便于替换 AI 角色形象
		const avatarPath = ((import.meta as unknown) as { env?: { VITE_AI_AVATAR_PATH?: string } }).env?.VITE_AI_AVATAR_PATH || '/ai-assistant.svg';
		return window.location.origin + avatarPath;
	}
	return '';
};

const buildOpenAIMessages = (all: IMessageItem[], nextUserText: string, userId: unknown) => {
	const persona = getPersonaPrompt();
	const msgs: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
		{ role: 'system', content: persona }
	];
	for (const m of all) {
		if (m.sender_id === userId) msgs.push({ role: 'user', content: m.content });
		else msgs.push({ role: 'assistant', content: m.content });
	}
	msgs.push({ role: 'user', content: nextUserText });
	return msgs;
};

const buildContextText = (messages: IMessageItem[] = []) =>
	messages
		.slice(-20)
		.map(item => `${item.sender_id}: ${item.content}`)
		.join('\n');

const buildAgentDisplayText = (data: AgentResponse): string => {
	const parts = [data.content, data.summary ? `\n总结：${data.summary}` : ''].filter(Boolean);
	return sanitizeAiContent(parts.join('\n'));
};

const streamAgentReply = async (
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
	if (response.status === 401 && tokenStorage.getItem() === requestToken) invalidateDesktopAuth(requestToken);
	if (!response.ok || !response.body) throw new Error(response.status === 403
		? '没有权限访问该会话。' : response.status === 401 ? '登录已失效，请在主窗口重新登录。' : 'AI 服务连接失败，请稍后重试。');
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let text = '';
	let result: AgentResponse | undefined;
	const handleEvent = (frame: string) => {
		const event = frame.match(/^event: (.+)$/m)?.[1];
		const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
		if (!data || data === '[DONE]') return;
		if (event === 'agent') {
			onEvent?.(JSON.parse(data) as AgentEvent);
			return;
		}
		const value = JSON.parse(data) as AgentResponse & { delta?: string; reset?: boolean; error?: string };
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
			if (value) buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
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

/**
 * M1: AI 助手 hook，从 Chat 页面抽取
 * 通过后端代理调用大模型（H4: 不再在前端暴露 API Key）
 * 非流式调用在 Agent 不可用时降级到普通聊天；流式调用失败时显示错误
 */
export const useAiAssistant = (user: IUserInfo) => {
	const [aiHistory, setAiHistory] = useState<IMessageItem[]>([]);

	const generateReply = useCallback(
		async (
			userText: string,
			history: IMessageItem[],
			options: GenerateReplyOptions = {}
		): Promise<AgentReplyResult> => {
			const context = {
				currentChatType: options.currentChatType || 'assistant',
				currentReceiverId: options.currentReceiverId,
				recentMessagesText: buildContextText(options.recentMessages || history),
				memoryEnabled: options.memoryEnabled !== false
			};
			if (options.onDelta) {
				try {
					const agentData = await streamAgentReply(userText, options.room, context, options.onDelta, options.onEvent, options.signal);
					return { ...agentData, text: buildAgentDisplayText(agentData) };
				} catch (error) {
					if (options.throwOnError) throw error;
					const errorText = 'AI 服务暂时不可用，本次回答未完成。若涉及写操作，请在助手面板查询状态后再重试。';
					return { content: errorText, text: errorText, actions: [] };
				}
			}
			try {
				const agentRes = await request.post<
					{
						input: string;
						room?: string;
						context: {
						currentChatType?: string;
						currentReceiverId?: number;
						recentMessagesText?: string;
						memoryEnabled?: boolean;
					};
				},
					AgentResponse
				>('/assistant/agent', {
					input: userText,
					room: options.room,
					context
				});
				const agentData = agentRes.data?.data;
				if (agentData?.content) {
					return {
						...agentData,
						text: buildAgentDisplayText(agentData)
					};
				}
			} catch {
				/* agent 不可用时继续走普通聊天补全 */
			}

			try {
				const messages = buildOpenAIMessages(history, userText, user.id);
				// H4: 通过后端代理调用，不暴露 API Key
				const res = await request.post<{ messages: ReturnType<typeof buildOpenAIMessages> }, ChatResponse>(
					'/assistant/chat',
					{ messages }
				);
				const content = res.data?.data?.content;
				// 漏洞2: 前端兜底 sanitize
				if (content) {
					const notice = '提示：Agent 本次未能完成；以下回答来自普通 AI 聊天，不包含 Agent 的工具结果。\n\n';
					return { content: notice + content, text: notice + sanitizeAiContent(content), actions: [] };
				}
			} catch {
				// 两条后端路径均不可用时明确显示失败，不生成看似正常的模板回答。
			}
			const errorText = 'AI 服务暂时不可用，本次没有生成可用回答。若涉及写操作，请在助手面板查询状态后再重试。';
			return { content: errorText, text: errorText, actions: [] };
		},
		[user]
	);

	const appendAiHistory = useCallback((msg: IMessageItem) => {
		setAiHistory(prev => [...prev, msg]);
	}, []);

	const setAiHistoryAll = useCallback((msgs: IMessageItem[]) => {
		setAiHistory(msgs);
	}, []);

	return {
		aiHistory,
		appendAiHistory,
		setAiHistory: setAiHistoryAll,
		generateReply
	};
};
