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
import { createPendingAction, type AgentAction } from './actions';
import {
	AGENT_PROMPT_VERSION,
	POMELO_AGENT_SYSTEM_PROMPT,
	POMELO_AGENT_USER_INSTRUCTION
} from './agent-prompts';

const API_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/v1\/?$/, '');
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const UPSTREAM_TIMEOUT_MS = 30000;
const MAX_INPUT_LENGTH = 8000;
const MAX_CONTEXT_LENGTH = 20000;
const MAX_ROOM_LENGTH = 128;
const RATE_LIMIT_PER_MIN = 20;

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
	promptVersion: string;
}

interface AgentMessage {
	_getType?: () => string;
	content?: unknown;
	name?: unknown;
	tool_call_id?: unknown;
}

interface AgentInvocation {
	messages?: AgentMessage[];
	structuredResponse?: Partial<StructuredAgentResponse>;
}

const parseAgentInvocation = (value: unknown): AgentInvocation => {
	if (!isRecord(value)) return {};
	const messages = Array.isArray(value.messages)
		? value.messages.filter(isRecord).map(message => {
			const getType = message._getType;
			return {
				_getType: typeof getType === 'function'
					? () => {
						const type = getType();
						return typeof type === 'string' ? type : '';
					}
					: undefined,
				content: message.content,
				name: message.name,
				tool_call_id: message.tool_call_id
			};
		})
		: undefined;
	const parsedStructured = AgentResponseSchema.partial().safeParse(value.structuredResponse);
	return { messages, structuredResponse: parsedStructured.success ? parsedStructured.data : undefined };
};

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
type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
	typeof value === 'object' && value !== null;

const stringProperty = (value: UnknownRecord, key: string): string => {
	const property = value[key];
	return typeof property === 'string' ? property : '';
};

const recordArray = (value: unknown): UnknownRecord[] =>
	Array.isArray(value) ? value.filter(isRecord) : [];

interface ToolPayload {
	isError?: boolean;
	content?: unknown;
	message?: string;
	city?: string;
	forecasts?: WeatherForecast[];
	transits?: TransitRoute[];
	results?: GeoResult[];
}

interface WeatherForecast {
	dayweather?: string;
	nightweather?: string;
	daytemp?: string | number;
	nighttemp?: string | number;
	daywind?: string;
	daypower?: string | number;
}

interface TransitRoute {
	duration?: string | number;
	walking_distance?: string | number;
	segments?: TransitSegment[];
}

interface TransitSegment {
	bus?: { buslines?: Array<{ name?: string }> };
}

interface GeoResult {
	province?: string;
	city?: string;
	district?: string;
	street?: string;
	number?: string;
	location?: string;
}

const isToolError = (value: unknown): boolean => isRecord(value) && value.isError === true;

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

const parseToolResult = (content: unknown): unknown => {
	const text = normalizeMessageContent(content);
	if (!text) return null;
	const walk = (value: unknown, depth: number): unknown => {
		if (depth > 6 || value === null || value === undefined) return value;
		if (typeof value === 'string') {
			try {
				return walk(JSON.parse(value), depth + 1);
			} catch {
				return value;
			}
		}
		if (!isRecord(value)) return value;
		if (value.isError || value.forecasts || value.transits || value.results) return value;
		if (value.structuredContent) return walk(value.structuredContent, depth + 1);
		if (Array.isArray(value.content)) {
			for (const block of value.content) {
				const nested = walk(isRecord(block) ? block.text || block : block, depth + 1);
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
	if (!isRecord(result)) return JSON.stringify(result, null, 2);
	const payload = result as ToolPayload;

	if (payload.isError) {
		const message = normalizeMessageContent(result.content) || result.message || '工具暂时不可用';
		return `${name} 暂时不可用：${String(message).replace(/\s+/g, ' ').slice(0, 180)}`;
	}

	if (name.includes('maps_weather') && Array.isArray(payload.forecasts)) {
		const first = payload.forecasts[0];
		if (!first) return '';
		return `${result.city || '查询城市'}：${first.dayweather}转${first.nightweather}，${first.daytemp}℃ / ${first.nighttemp}℃，${first.daywind || ''}风，风力${first.daypower || '未知'}。`;
	}

	if (name.includes('direction_transit_integrated') && Array.isArray(payload.transits)) {
		return payload.transits.slice(0, 3).map((item, index: number) => {
			const minutes = Math.round(Number(item.duration || 0) / 60);
			const walking = item.walking_distance ? `${item.walking_distance}米` : '未知';
			const lines = (item.segments || [])
				.flatMap(segment => (segment.bus?.buslines || []).map(line => line.name))
				.filter(Boolean);
			return `方案${index + 1}：约${minutes}分钟，步行${walking}${lines.length ? `，乘坐${[...new Set(lines)].join('、')}` : ''}`;
		}).join('\n');
	}

	if (name.includes('maps_geo') && Array.isArray(payload.results)) {
		return payload.results.slice(0, 3).map(item =>
			`${[item.province, item.city, item.district, item.street, item.number].flat().filter(Boolean).join('')}（坐标：${item.location || '未知'}）`
		).join('\n');
	}

	return JSON.stringify(result, null, 2);
};

const buildToolBackedContent = (
	content: string,
	toolOutputs: Array<{ name: string; content: unknown }>
): string => {
	const safeContent = content
		.replace(/\{[\s\S]{0,600}USER_DAILY_QUERY_OVER_LIMIT[\s\S]{0,600}\}/g, '地图或搜索工具暂时不可用：外部服务额度已用完。')
		.replace(/\{[\s\S]{0,600}"isError"\s*:\s*true[\s\S]{0,600}\}/g, '工具暂时不可用，请稍后再试。');
	const formatted = toolOutputs
		.map(item => {
			const result = formatToolResult(item.name, item.content);
			return result ? `【${item.name}】\n${result}` : '';
		})
		.filter(Boolean)
		.join('\n\n')
		.slice(0, 16000);
	if (!formatted) return safeContent;
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
			recentMessagesText,
			memoryEnabled: rawContext.memoryEnabled !== false
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


const buildActions = async (
	userId: number,
	result: StructuredAgentResponse,
	room?: string,
	context?: AgentContext
): Promise<AgentAction[]> => {
	const actions: AgentAction[] = [];

	if (result.replySuggestions.length > 0) {
		actions.push({
			type: 'reply_suggestion',
			requiresConfirmation: false,
			payload: { suggestions: result.replySuggestions.slice(0, 5) }
		});
	}

	if (result.todos.length > 0) {
		try {
			actions.push(await createPendingAction(userId, 'create_tasks', { todos: result.todos, sourceRoom: room }));
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[assistant-action] could not create task confirmation:', err.message);
		}
	}

	if (result.draftMessage && room && (context?.currentChatType === 'private' || context?.currentChatType === 'group')) {
		try {
			actions.push(await createPendingAction(userId, 'send_message', {
				room,
				chatType: context.currentChatType,
				content: result.draftMessage
			}));
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[assistant-action] could not create message confirmation:', err.message);
		}
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
	if (context?.memoryEnabled !== false) {
		try {
			memoryContext = await executePomeloTool(
				{ userId, currentRoom: room },
				{ name: 'search_memory', args: { query: input, limit: 8 } }
			);
		} catch {
			// Memory is optional; a database or legacy-schema failure must not block chat.
		}
	}
	const preloadedTools = agentPlan.preToolTrace
		.filter(item => item.status === 'success')
		.map(item => item.tool);
	const excludedTools = context?.memoryEnabled === false
		? [...preloadedTools, 'search_memory', 'save_memory', 'forget_memory']
		: preloadedTools;
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
				{ exclude: excludedTools }
			),
			...(await externalMcpManager.buildTools())
		],
		responseFormat: AgentResponseSchema,
		systemPrompt: POMELO_AGENT_SYSTEM_PROMPT
	});

	const rawResult: unknown = await agent.invoke({
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
					promptVersion: AGENT_PROMPT_VERSION,
					instruction: POMELO_AGENT_USER_INSTRUCTION
				})
			}
		]
	});
	const result = parseAgentInvocation(rawResult);
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
		.map(item => ({
			name: String(item.name || item.tool_call_id || 'tool'),
			status: isToolError(parseToolResult(item.content)) ? 'error' as const : 'success' as const
		}))
		.filter(item => !/^extract-\d+$/.test(String(item.name)))
		.map(item => ({ tool: item.name, status: item.status }));

	const actions = await buildActions(userId, structured, room, context);
	return {
		...structured,
		content: buildToolBackedContent(structured.content, toolOutputs),
		actions,
		toolTrace: [
			...agentPlan.preToolTrace,
			...toolTrace,
			...actions.filter(action => action.requiresConfirmation).map(action => ({ tool: `action:${action.type}`, status: 'success' as const }))
		],
		agentTrace: agentPlan.agentTrace,
		agentSteps: agentPlan.agentSteps,
		promptVersion: AGENT_PROMPT_VERSION
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
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
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
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
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
			? await externalMcpManager.callTool(name, args || {}, confirmed === true, userId)
			: await executePomeloTool(
					{ userId, currentRoom: typeof room === 'string' ? room : undefined },
					{ name, args: args || {}, room }
			  );
		RespData(res, { name, result });
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[assistant-agent] callAgentTool error:', err.message);
		RespError(res, CommonStatus.PARAM_ERR);
	}
};
