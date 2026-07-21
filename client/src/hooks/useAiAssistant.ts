import { useCallback, useState } from 'react';

import { IMessageItem } from '@/components/MessageShow/type';
import { sanitizeAiContent } from '@/utils/sanitize';
import { IUserInfo } from '@/utils/storage';
import request from '@/utils/request';

// AI 助手用户名与头像
export const AI_USERNAME = 'ai-assistant';

interface AgentAction {
	type: 'todo_suggestion' | 'reply_suggestion' | 'send_message_draft';
	requiresConfirmation: boolean;
	payload: Record<string, unknown>;
}

export interface AgentTodo {
	title: string;
	assignee?: string;
	due?: string;
}

export interface AgentStep {
	agent: string;
	role: 'coordinator' | 'context' | 'todo' | 'reply';
	status: 'planned' | 'success' | 'skipped' | 'error';
	detail?: string;
	tools?: string[];
	durationMs?: number;
}

export interface AgentResponse {
	content: string;
	summary?: string;
	todos?: AgentTodo[];
	replySuggestions?: string[];
	draftMessage?: string;
	actions?: AgentAction[];
	toolTrace?: Array<{ tool: string; status: 'success' | 'error' }>;
	agentTrace?: string[];
	agentSteps?: AgentStep[];
}

export interface AgentReplyResult extends AgentResponse {
	text: string;
}

interface GenerateReplyOptions {
	room?: string;
	currentChatType?: string;
	currentReceiverId?: number;
	recentMessages?: IMessageItem[];
	memoryEnabled?: boolean;
}

interface ChatResponse {
	content: string;
}

// 大模型人设提示（优先 localStorage，回退内置）
const DEFAULT_PERSONA_PROMPT = `你是一个友好、实用的AI助手。说话风格：\n1) 简洁清晰，直接回应用户问题；\n2) 口语自然，礼貌得体；\n3) 不输出不当内容；\n4) 一般不超过100字，除非用户要求详细。\n不要透露系统或你是大模型。`;

export const getPersonaPrompt = () => {
	if (typeof window !== 'undefined') {
		return localStorage.getItem('AI_PERSONA_PROMPT') || DEFAULT_PERSONA_PROMPT;
	}
	return DEFAULT_PERSONA_PROMPT;
};

export const getAiAvatar = () => {
	if (typeof window !== 'undefined') {
		// 头像路径从环境变量读取，便于替换 AI 角色形象
		const avatarPath = ((import.meta as unknown) as { env?: { VITE_AI_AVATAR_PATH?: string } }).env?.VITE_AI_AVATAR_PATH || '/yuzu.svg';
		return window.location.origin + avatarPath;
	}
	return '';
};

// 回退：本地启发式（通用 AI 助手风格）
const genAiReply = (text: string): string => {
	const msg = text.trim();
	if (!msg) return '我在听，请继续说。';
	const isQuestion = /[?？]$/.test(msg) || /(吗|么|如何|怎么|为何|原因|可以|能否)/.test(msg);
	const isGreeting = /(你好|在吗|早上好|晚上好|hello|hi|嗨)/i.test(msg);
	const isThanks = /(谢谢|多谢|辛苦|感激)/.test(msg);
	if (isGreeting) return '你好！我是AI助手，有什么可以帮你的吗？';
	if (isThanks) return '不客气，能帮上忙就好。还有其他问题吗？';
	if (isQuestion) {
		return '让我想想。可以从目标开始，逐步分解，再一点点推进。若有更多细节，告诉我吧。';
	}
	return '我明白了。你愿意多说一点细节吗？这样我能更好地帮助你。';
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

/**
 * M1: AI 助手 hook，从 Chat 页面抽取
 * 通过后端代理调用大模型（H4: 不再在前端暴露 API Key）
 * 无 Key 或后端不可用时回退本地启发式
 */
export const useAiAssistant = (user: IUserInfo) => {
	const [aiHistory, setAiHistory] = useState<IMessageItem[]>([]);

	const generateReply = useCallback(
		async (
			userText: string,
			history: IMessageItem[],
			options: GenerateReplyOptions = {}
		): Promise<AgentReplyResult> => {
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
					context: {
						currentChatType: options.currentChatType || 'assistant',
						currentReceiverId: options.currentReceiverId,
						recentMessagesText: buildContextText(options.recentMessages || history),
						memoryEnabled: options.memoryEnabled !== false
					}
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
				if (content) return { content, text: sanitizeAiContent(content), actions: [] };
				const fallback = genAiReply(userText);
				return { content: fallback, text: fallback, actions: [] };
			} catch {
				// 后端不可用或无 Key，回退本地启发式
				const fallback = genAiReply(userText);
				return { content: fallback, text: fallback, actions: [] };
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
