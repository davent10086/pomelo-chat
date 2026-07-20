import { createAgent } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import type { Request, Response } from 'express';

import { CommonStatus, AssistantStatus } from '../../utils/status';
import { RespData, RespError } from '../../utils/resp';
import { better_chat } from '../../utils/authenticate';
import {
	runAgentOrchestrator,
	type AgentContext,
	type AgentEvent,
	type AgentStep
} from './agent-orchestrator';
import { buildPomeloChatTools, executePomeloTool, pomeloToolDefinitions } from './tools/pomelo-tools';
import { externalMcpManager } from './tools/external-mcp';

const API_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/v1\/?$/, '');
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const UPSTREAM_TIMEOUT_MS = 30000;
const MAX_INPUT_LENGTH = 8000;
const MAX_CONTEXT_LENGTH = 20000;
const MAX_ROOM_LENGTH = 128;
const RATE_LIMIT_PER_MIN = 20;

interface AgentAction {
	type: 'todo_suggestion' | 'reply_suggestion' | 'send_message_draft';
	requiresConfirmation: boolean;
	payload: Record<string, unknown>;
}

interface AgentTodo {
	title: string;
	assignee?: string;
	due?: string;
}

interface AgentResult {
	content: string;
	summary?: string;
	todos: AgentTodo[];
	replySuggestions: string[];
	draftMessage?: string;
	actions: AgentAction[];
	toolTrace: Array<{ tool: string; status: 'success' | 'error' }>;
	agentTrace: string[];
	agentSteps: AgentStep[];
}

const rateLimitMap = new Map<string, number[]>();

const AgentResponseSchema = z.object({
	content: z.string().describe('给用户看的自然语言回答，简洁说明本次结果'),
	summary: z.string().optional().describe('如果用户要求总结聊天，在这里放总结'),
	todos: z
		.array(
			z.object({
				title: z.string().describe('待办事项标题'),
				assignee: z.string().optional().describe('负责人，没有就省略'),
				due: z.string().optional().describe('截止时间，没有就省略')
			})
		)
		.default([])
		.describe('从聊天或用户输入中提取的待办建议'),
	replySuggestions: z
		.array(z.string())
		.default([])
		.describe('可点击填入输入框的回复建议，最多 5 条'),
	draftMessage: z.string().optional().describe('可选消息草稿，不自动发送')
});

type StructuredAgentResponse = z.infer<typeof AgentResponseSchema>;

const sanitizeContent = (text: string): string => {
	return String(text)
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
		.replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
		.replace(/\son\w+\s*=\s*'[^']*'/gi, '')
		.replace(/javascript:/gi, '');
};

const normalizeMessageContent = (content: unknown): string => {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map(item => {
				if (typeof item === 'string') return item;
				if (item && typeof item === 'object' && 'text' in item) {
					return String((item as { text?: unknown }).text || '');
				}
				return '';
			})
			.filter(Boolean)
			.join('');
	}
	return '';
};

const parseToolResult = (content: unknown): any => {
	const text = normalizeMessageContent(content);
	if (!text) return null;
	const walk = (value: any, depth: number): any => {
		if (depth > 6 || value === null || value === undefined) return value;
		if (typeof value === 'string') {
			try {
				return walk(JSON.parse(value), depth + 1);
			} catch {
				return value;
			}
		}
		if (typeof value !== 'object') return value;
		if (value.forecasts || value.transits || value.results) return value;
		if (value.structuredContent) return walk(value.structuredContent, depth + 1);
		if (Array.isArray(value.content)) {
			for (const block of value.content) {
				const nested = walk(block?.text || block, depth + 1);
				if (nested && typeof nested === 'object') return nested;
			}
		}
		return value;
	};
	return walk(text, 0);
};

const formatToolResult = (name: string, content: unknown): string => {
	const result = parseToolResult(content);
	if (!result) return '';
	if (typeof result === 'string') return result;

	if (name.includes('maps_weather') && Array.isArray(result.forecasts)) {
		const first = result.forecasts[0];
		if (!first) return '';
		return `${result.city || '查询城市'}：${first.dayweather}转${first.nightweather}，${first.daytemp}℃ / ${first.nighttemp}℃，${first.daywind || ''}风，风力${first.daypower || '未知'}。`;
	}

	if (name.includes('direction_transit_integrated') && Array.isArray(result.transits)) {
		return result.transits.slice(0, 3).map((item: any, index: number) => {
			const minutes = Math.round(Number(item.duration || 0) / 60);
			const walking = item.walking_distance ? `${item.walking_distance}米` : '未知';
			const lines = (item.segments || [])
				.flatMap((segment: any) => (segment.bus?.buslines || []).map((line: any) => line.name))
				.filter(Boolean);
			return `方案${index + 1}：约${minutes}分钟，步行${walking}${lines.length ? `，乘坐${[...new Set(lines)].join('、')}` : ''}`;
		}).join('\n');
	}

	if (name.includes('maps_geo') && Array.isArray(result.results)) {
		return result.results.slice(0, 3).map((item: any) =>
			`${[item.province, item.city, item.district, item.street, item.number].flat().filter(Boolean).join('')}（坐标：${item.location || '未知'}）`
		).join('\n');
	}

	return JSON.stringify(result, null, 2);
};

const buildToolBackedContent = (
	content: string,
	toolOutputs: Array<{ name: string; content: unknown }>
): string => {
	const formatted = toolOutputs
		.map(item => {
			const result = formatToolResult(item.name, item.content);
			return result ? `【${item.name}】\n${result}` : '';
		})
		.filter(Boolean)
		.join('\n\n')
		.slice(0, 16000);
	if (!formatted) return content;
	return `${content}\n\n查询到的具体结果：\n${formatted}`.slice(0, 18000);
};

export const normalizeAgentRequest = (
	room: unknown,
	context: unknown
): { room?: string; context: AgentContext } => {
	const rawContext = context && typeof context === 'object' ? (context as Record<string, unknown>) : {};
	const currentChatType = rawContext.currentChatType;
	const receiverId = Number(rawContext.currentReceiverId);
	const recentMessagesText = typeof rawContext.recentMessagesText === 'string'
		? rawContext.recentMessagesText.slice(-MAX_CONTEXT_LENGTH)
		: undefined;
	return {
		room: typeof room === 'string' && room.length <= MAX_ROOM_LENGTH ? room : undefined,
		context: {
			currentChatType:
				currentChatType === 'private' || currentChatType === 'group' || currentChatType === 'assistant'
					? currentChatType
					: undefined,
			currentReceiverId: Number.isFinite(receiverId) ? receiverId : undefined,
			recentMessagesText
		}
	};
};

const checkRateLimit = async (userId: number | string): Promise<boolean> => {
	const key = String(userId);
	try {
		const redisKey = `ai_agent_rate:${key}`;
		const count = await better_chat.incr(redisKey);
		if (count === 1) {
			await better_chat.expire(redisKey, 60);
		}
		return count <= RATE_LIMIT_PER_MIN;
	} catch {
		const now = Date.now();
		const arr = (rateLimitMap.get(key) || []).filter(t => now - t < 60000);
		if (arr.length >= RATE_LIMIT_PER_MIN) return false;
		arr.push(now);
		rateLimitMap.set(key, arr);
		return true;
	}
};

const buildActions = (result: StructuredAgentResponse): AgentAction[] => {
	const actions: AgentAction[] = [];

	if (result.replySuggestions.length > 0) {
		actions.push({
			type: 'reply_suggestion',
			requiresConfirmation: true,
			payload: { suggestions: result.replySuggestions.slice(0, 5) }
		});
	}

	if (result.todos.length > 0) {
		actions.push({
			type: 'todo_suggestion',
			requiresConfirmation: true,
			payload: { todos: result.todos }
		});
	}

	if (result.draftMessage) {
		actions.push({
			type: 'send_message_draft',
			requiresConfirmation: true,
			payload: { text: result.draftMessage }
		});
	}

	return actions;
};

const normalizeStructuredResponse = (
	value: Partial<StructuredAgentResponse> | undefined,
	fallbackContent: string
): StructuredAgentResponse => ({
	content: sanitizeContent(value?.content || fallbackContent || '我暂时没有得到有效结果。'),
	summary: value?.summary ? sanitizeContent(value.summary) : undefined,
	todos: Array.isArray(value?.todos)
		? value.todos
				.filter(item => item && typeof item.title === 'string' && item.title.trim())
				.slice(0, 8)
				.map(item => ({
					title: sanitizeContent(item.title.trim()),
					assignee: item.assignee ? sanitizeContent(item.assignee) : undefined,
					due: item.due ? sanitizeContent(item.due) : undefined
				}))
		: [],
	replySuggestions: Array.isArray(value?.replySuggestions)
		? value.replySuggestions
				.filter(item => typeof item === 'string' && item.trim())
				.slice(0, 5)
				.map(item => sanitizeContent(item.trim()))
		: [],
	draftMessage: value?.draftMessage ? sanitizeContent(value.draftMessage) : undefined
});

const runLangChainAgent = async (
	userId: number,
	input: string,
	room?: string,
	context?: AgentContext,
	onEvent?: (event: AgentEvent) => void
): Promise<AgentResult> => {
	const agentPlan = await runAgentOrchestrator({ userId, input, room, context, onEvent });
	let memoryContext: Record<string, unknown> = { memories: [] };
	try {
		memoryContext = await executePomeloTool(
			{ userId, currentRoom: room },
			{ name: 'search_memory', args: { query: input, limit: 8 } }
		);
	} catch {
		// Memory is optional; a database or legacy-schema failure must not block chat.
	}
	const preloadedTools = agentPlan.preToolTrace
		.filter(item => item.status === 'success')
		.map(item => item.tool);
	const model = new ChatOpenAI({
		model: MODEL,
		apiKey: API_KEY,
		temperature: 0.3,
		timeout: UPSTREAM_TIMEOUT_MS,
		maxRetries: 1,
		streamUsage: false,
		configuration: {
			baseURL: `${API_BASE}/v1`
		}
	});
	const agent = createAgent({
		model,
		tools: [
			...buildPomeloChatTools(
				{ userId, currentRoom: room },
				{ exclude: preloadedTools }
			),
			...(await externalMcpManager.buildTools())
		],
		responseFormat: AgentResponseSchema,
		systemPrompt: `你是 Pomelo Chat 的聊天助手 Agent。你只能帮助当前登录用户处理聊天相关任务。
可用能力：查询用户可见的聊天记录、搜索联系人和群聊、提取待办建议、生成回复草稿。
安全要求：不要查询或推测用户不可见的数据；不要自动发消息、建群、改资料或写数据库；需要写操作时只给出待确认草稿。
回答要求：使用中文，简洁清楚。若你调用了工具，请基于工具结果回答；若缺少信息，请说明需要用户提供什么。
结构化要求：如果用户要求总结，填写 summary；如果提到待办、提醒、安排，填写 todos；如果要求怎么回复，填写 replySuggestions；如果用户要代写消息，填写 draftMessage。`
	});

	const result: any = await agent.invoke({
		messages: [
			{
				role: 'user',
				content: JSON.stringify({
					input,
					room,
					context: context || {},
					memoryContext,
					intent: agentPlan.intent,
					selectedAgents: agentPlan.agentTrace,
					orchestratorObservations: agentPlan.observations,
					instruction: 'Use orchestratorObservations and memoryContext as context. Do not repeat a preloaded tool call unless its result is missing or insufficient. If the user explicitly asks to remember/save a preference or fact, call save_memory; never save secrets, credentials, or full transcripts. If the user explicitly asks to forget/delete a memory, call forget_memory. If any tool is called, the final content must directly include the concrete tool results. Never reply only with an acknowledgement such as "好的，我来整理" or "正在查询". For route requests, include origin, destination, transport mode, transfer plan, estimated duration, and walking details; for weather requests, include weather, temperature, and travel advice. If a field is unavailable, say so explicitly.'
				})
			}
		]
	});
	const messages = Array.isArray(result?.messages) ? result.messages : [];
	const lastAiMessage = [...messages]
		.reverse()
		.find(item => item?._getType?.() === 'ai' && normalizeMessageContent(item.content));
	const fallbackContent = sanitizeContent(normalizeMessageContent(lastAiMessage?.content) || '我暂时没有得到有效结果。');
	const structured = normalizeStructuredResponse(result?.structuredResponse, fallbackContent);
	const toolOutputs = messages
		.filter(item => item?._getType?.() === 'tool')
		.map(item => ({ name: String(item.name || item.tool_call_id || 'tool'), content: item.content }))
		.filter(item => item.name.startsWith('mcp_'));
	const toolTrace = messages
		.filter(item => item?._getType?.() === 'tool')
		.map(item => item.name || item.tool_call_id || 'tool')
		.filter(name => !/^extract-\d+$/.test(String(name)))
		.map(name => ({ tool: name, status: 'success' as const }));

	return {
		...structured,
		content: buildToolBackedContent(structured.content, toolOutputs),
		actions: buildActions(structured),
		toolTrace: [...agentPlan.preToolTrace, ...toolTrace],
		agentTrace: agentPlan.agentTrace,
		agentSteps: agentPlan.agentSteps
	};
};

export const agentChat = async (req: Request, res: Response): Promise<void> => {
	const { input, room, context } = req.body || {};
	if (!input || typeof input !== 'string' || input.length > MAX_INPUT_LENGTH) {
		RespError(res, input?.length > MAX_INPUT_LENGTH ? AssistantStatus.CONTENT_TOO_LONG : CommonStatus.PARAM_ERR);
		return;
	}
	if (!API_KEY) {
		RespError(res, CommonStatus.SERVER_ERR);
		return;
	}
	if (!(await checkRateLimit(req.user!.id))) {
		RespError(res, AssistantStatus.RATE_LIMIT_ERR);
		return;
	}
	try {
		const userId = Number(req.user!.id);
		if (!Number.isFinite(userId)) {
			RespError(res, CommonStatus.TOKEN_ERR);
			return;
		}
		const request = normalizeAgentRequest(room, context);
		const result = await runLangChainAgent(userId, input, request.room, request.context);
		RespData(res, result);
	} catch (err: any) {
		console.error('[assistant-agent] agentChat 异常:', err.message);
		RespError(res, err?.name === 'AbortError' ? AssistantStatus.UPSTREAM_TIMEOUT : CommonStatus.SERVER_ERR);
	}
};

export const agentStream = async (req: Request, res: Response): Promise<void> => {
	const { input, room, context } = req.body || {};
	if (!input || typeof input !== 'string' || input.length > MAX_INPUT_LENGTH) {
		RespError(res, input?.length > MAX_INPUT_LENGTH ? AssistantStatus.CONTENT_TOO_LONG : CommonStatus.PARAM_ERR);
		return;
	}
	if (!API_KEY) {
		RespError(res, CommonStatus.SERVER_ERR);
		return;
	}
	if (!(await checkRateLimit(req.user!.id))) {
		RespError(res, AssistantStatus.RATE_LIMIT_ERR);
		return;
	}
	res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders();
	try {
		const userId = Number(req.user!.id);
		if (!Number.isFinite(userId)) {
			res.write(`data: ${JSON.stringify({ error: 'token error' })}\n\n`);
			res.end();
			return;
		}
		const request = normalizeAgentRequest(room, context);
		const result = await runLangChainAgent(userId, input, request.room, request.context, event => {
			if (!res.writableEnded) res.write(`event: agent\ndata: ${JSON.stringify(event)}\n\n`);
		});
		res.write(`data: ${JSON.stringify(result)}\n\n`);
		res.write('data: [DONE]\n\n');
		res.end();
	} catch (err: any) {
		console.error('[assistant-agent] agentStream 异常:', err.message);
		res.write(`data: ${JSON.stringify({ error: 'internal error' })}\n\n`);
		res.end();
	}
};

export const listAgentTools = async (_req: Request, res: Response): Promise<void> => {
	const externalTools = await externalMcpManager.getTools();
	RespData(res, { tools: [...pomeloToolDefinitions, ...externalTools.map(item => item.definition)] });
};

export const callAgentTool = async (req: Request, res: Response): Promise<void> => {
	const { name, args, room, confirmed } = req.body || {};
	if (!name || typeof name !== 'string' || (args && typeof args !== 'object')) {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}

	try {
		const userId = Number(req.user!.id);
		if (!Number.isFinite(userId)) {
			RespError(res, CommonStatus.TOKEN_ERR);
			return;
		}
		const result = name.startsWith('mcp_')
			? await externalMcpManager.callTool(name, args || {}, confirmed === true)
			: await executePomeloTool(
					{ userId, currentRoom: typeof room === 'string' ? room : undefined },
					{ name, args: args || {}, room }
			  );
		RespData(res, { name, result });
	} catch (err: any) {
		console.error('[assistant-agent] callAgentTool error:', err.message);
		RespError(res, CommonStatus.PARAM_ERR);
	}
};
