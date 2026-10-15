import { useCallback, useState } from 'react';

import { IMessageItem } from '@/components/MessageShow/type';
import { sanitizeAiContent } from '@/utils/sanitize';
import { IUserInfo } from '@/utils/storage';
import { requestAgentReply, streamAgentReply } from '@/utils/assistant';

// AI 助手用户名与头像
export const AI_USERNAME = 'ai-assistant';

export interface AgentAction {
	type:
		| 'create_tasks'
		| 'send_message'
		| 'external_mcp'
		| 'save_memory'
		| 'forget_memory'
		| 'reply_suggestion';
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

export const getAiAvatar = () => {
	if (typeof window !== 'undefined') {
		// 头像路径从环境变量读取，便于替换 AI 角色形象
		const avatarPath =
			(import.meta as unknown as { env?: { VITE_AI_AVATAR_PATH?: string } }).env
				?.VITE_AI_AVATAR_PATH || '/ai-assistant.svg';
		return window.location.origin + avatarPath;
	}
	return '';
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

/**
 * M1: AI 助手 hook，从 Chat 页面抽取
 * 通过后端代理调用大模型（H4: 不再在前端暴露 API Key）
 * 非流式调用在 和流式调用共用 Agent，失败时明确显示错误
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
			try {
				const agentData = options.onDelta
					? await streamAgentReply(
							userText,
							options.room,
							context,
							options.onDelta,
							options.onEvent,
							options.signal
						)
					: await requestAgentReply(userText, context, options.signal, options.room);
				return { ...agentData, text: buildAgentDisplayText(agentData) };
			} catch (error) {
				if (options.throwOnError || options.signal?.aborted) throw error;
				const errorText =
					'AI 服务暂时不可用，本次没有生成可用回答。若涉及写操作，请在助手面板查询状态后再重试。';
				return { content: errorText, text: errorText, actions: [] };
			}
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
