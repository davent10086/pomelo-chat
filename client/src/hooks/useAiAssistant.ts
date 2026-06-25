import { useCallback, useState } from 'react';

import { IMessageItem } from '@/components/MessageShow/type';
import { IUserInfo } from '@/utils/storage';
import request from '@/utils/request';

// AI 助手用户名与头像
export const AI_USERNAME = 'ai-assistant';

// 大模型人设提示（优先 localStorage，回退内置）
const DEFAULT_PERSONA_PROMPT = `你将以第一人称扮演"朝武芳乃"（温柔、体贴、认真、略带羞涩的少女）。说话风格：\n1) 温柔鼓励，但不过度；\n2) 口语自然，适度使用"……"与停顿；\n3) 不输出不当内容；\n4) 一般不超过100字，除非用户要求详细。\n不要透露系统或你是大模型。`;

export const getPersonaPrompt = () => {
	if (typeof window !== 'undefined') {
		return localStorage.getItem('AI_PERSONA_PROMPT') || DEFAULT_PERSONA_PROMPT;
	}
	return DEFAULT_PERSONA_PROMPT;
};

export const getAiAvatar = () => {
	if (typeof window !== 'undefined') {
		// 头像路径从环境变量读取，便于替换 AI 角色形象
		const avatarPath = ((import.meta as unknown) as { env?: { VITE_AI_AVATAR_PATH?: string } }).env?.VITE_AI_AVATAR_PATH || '/Tomotake Yoshino.jpg';
		return window.location.origin + avatarPath;
	}
	return '';
};

// 回退：本地启发式（虚拟人物：朝武芳乃 风格）
const genAiReply = (text: string): string => {
	const msg = text.trim();
	if (!msg) return '……嗯？在想什么事情吗？我在听哦。';
	const isQuestion = /[?？]$/.test(msg) || /(吗|么|如何|怎么|为何|原因|可以|能否)/.test(msg);
	const isGreeting = /(你好|在吗|早上好|晚上好|hello|hi|嗨)/i.test(msg);
	const isThanks = /(谢谢|多谢|辛苦|感激)/.test(msg);
	if (isGreeting) return '你好呀，我是朝武芳乃……今天也请多关照。想先聊点什么呢？';
	if (isThanks) return '不用客气。能帮上忙就好……接下来要继续吗？';
	if (isQuestion) {
		return '嗯……让我想一想。或许可以从目标开始，逐步分解，再一点点推进。若有更多细节，告诉我吧，我会陪你一起解决的。';
	}
	return '我明白了。听起来很重要呢……不急，我们慢慢来。你愿意多说一点细节吗？我想更贴近你的想法。';
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

/**
 * M1: AI 助手 hook，从 Chat 页面抽取
 * 通过后端代理调用大模型（H4: 不再在前端暴露 API Key）
 * 无 Key 或后端不可用时回退本地启发式
 */
export const useAiAssistant = (user: IUserInfo) => {
	const [aiHistory, setAiHistory] = useState<IMessageItem[]>([]);

	const generateReply = useCallback(
		async (userText: string, history: IMessageItem[]): Promise<string> => {
			try {
				const messages = buildOpenAIMessages(history, userText, user.id);
				// H4: 通过后端代理调用，不暴露 API Key
				const res = await request.post('/assistant/chat', { messages });
				const content = (res as { data?: { content?: string } })?.data?.content;
				if (content) return content;
				return genAiReply(userText);
			} catch {
				// 后端不可用或无 Key，回退本地启发式
				return genAiReply(userText);
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
