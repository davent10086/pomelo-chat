import { z } from 'zod';
import type { AgentAction } from './actions';
import type { AgentStep } from './agent-orchestrator';

interface AgentTodo {
	title: string;
	assignee?: string;
	due?: string;
}

export interface AgentResult {
	content: string;
	summary?: string;
	todos: AgentTodo[];
	replySuggestions: string[];
	draftMessage?: string;
	memorySuggestion?: { content: string; category?: string };
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

export const parseAgentInvocation = (value: unknown): AgentInvocation => {
	if (!isRecord(value)) return {};
	const messages = Array.isArray(value.messages)
		? value.messages.filter(isRecord).map(message => {
				const getType = message._getType;
				return {
					_getType:
						typeof getType === 'function'
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
	return {
		messages,
		structuredResponse: parsedStructured.success ? parsedStructured.data : undefined
	};
};

export const AgentResponseSchema = z.object({
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
	draftMessage: z.string().optional().describe('可选消息草稿，不自动发送'),
	memorySuggestion: z
		.object({
			content: z.string().min(1).max(1000),
			category: z.string().max(32).optional()
		})
		.optional()
		.describe('仅当用户明确要求记住时，提出待确认的记忆内容，不写入')
});

export type StructuredAgentResponse = z.infer<typeof AgentResponseSchema>;
type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
	typeof value === 'object' && value !== null;

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

export const isToolError = (value: unknown): boolean => isRecord(value) && value.isError === true;

export const sanitizeContent = (text: string): string => {
	return String(text)
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
		.replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
		.replace(/\son\w+\s*=\s*'[^']*'/gi, '')
		.replace(/javascript:/gi, '');
};

export const normalizeMessageContent = (content: unknown): string => {
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

export const parseToolResult = (content: unknown): unknown => {
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
		return payload.transits
			.slice(0, 3)
			.map((item, index: number) => {
				const minutes = Math.round(Number(item.duration || 0) / 60);
				const walking = item.walking_distance ? `${item.walking_distance}米` : '未知';
				const lines = (item.segments || [])
					.flatMap(segment => (segment.bus?.buslines || []).map(line => line.name))
					.filter(Boolean);
				return `方案${index + 1}：约${minutes}分钟，步行${walking}${lines.length ? `，乘坐${[...new Set(lines)].join('、')}` : ''}`;
			})
			.join('\n');
	}

	if (name.includes('maps_geo') && Array.isArray(payload.results)) {
		return payload.results
			.slice(0, 3)
			.map(
				item =>
					`${[item.province, item.city, item.district, item.street, item.number].flat().filter(Boolean).join('')}（坐标：${item.location || '未知'}）`
			)
			.join('\n');
	}

	return JSON.stringify(result, null, 2);
};

export const buildToolBackedContent = (
	content: string,
	toolOutputs: Array<{ name: string; content: unknown }>
): string => {
	const safeContent = content
		.replace(
			/\{[\s\S]{0,600}USER_DAILY_QUERY_OVER_LIMIT[\s\S]{0,600}\}/g,
			'地图或搜索工具暂时不可用：外部服务额度已用完。'
		)
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

export const normalizeStructuredResponse = (
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
	draftMessage: value?.draftMessage ? sanitizeContent(value.draftMessage) : undefined,
	memorySuggestion: value?.memorySuggestion?.content
		? {
				content: sanitizeContent(value.memorySuggestion.content.trim()).slice(0, 1000),
				category: value.memorySuggestion.category?.slice(0, 32)
			}
		: undefined
});

export const TaskCandidatesSchema = z.object({
	todos: z
		.array(
			z.object({
				title: z.string(),
				assignee: z.string().optional(),
				due: z.string().optional(),
				sourceMessageIds: z.array(z.unknown()).default([])
			})
		)
		.max(8)
});

export const validateTaskCandidateSources = (
	todos: Array<{ title: string; assignee?: string; due?: string; sourceMessageIds?: unknown[] }>,
	messages: Array<{ id: number; content: string; created_at: Date | string }>
) => {
	const visible = new Map(messages.map(item => [Number(item.id), item]));
	return todos
		.filter(item => item.title.trim())
		.slice(0, 8)
		.map(item => {
			const sourceMessageIds = [
				...new Set(
					(item.sourceMessageIds || []).filter(
						(id): id is number => typeof id === 'number' && Number.isInteger(id)
					)
				)
			].filter(id => visible.has(id));
			return {
				title: item.title.trim().slice(0, 500),
				assignee: item.assignee?.trim().slice(0, 255),
				due: item.due?.trim().slice(0, 255),
				sources: sourceMessageIds.map(id => ({
					id,
					content: visible.get(id)!.content.slice(0, 240),
					createdAt: visible.get(id)!.created_at
				}))
			};
		});
};
