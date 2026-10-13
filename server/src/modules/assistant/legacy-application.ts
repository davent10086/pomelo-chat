import { requestChatCompletion } from './adapters/legacy-model';
export interface ChatInput {
	messages?: unknown;
}
export interface NextStepsInput {
	contextText?: unknown;
	count?: unknown;
}
import type { Actor } from '../../shared/actor';
import { success, failure, type Outcome } from '../../shared/outcome';
/**
 * AI 助手后端代理服务
 * H4/M10: 将 DeepSeek API Key 移至后端，前端不再暴露密钥
 * 密钥从环境变量读取：DEEPSEEK_API_KEY
 */
import { CommonStatus, AssistantStatus } from '../../shared/status';
import { better_chat } from '../../infrastructure/redis';

export const API_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
export const API_KEY = process.env.DEEPSEEK_API_KEY || '';
export const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

// 上游请求超时（毫秒）
const UPSTREAM_TIMEOUT_MS = 30000;
// 单条消息最大长度（字符）
const MAX_MESSAGE_LENGTH = 8000;
// 最大消息条数
const MAX_MESSAGES_COUNT = 50;
// contextText 最大长度
const MAX_CONTEXT_LENGTH = 20000;

// 合法的消息 role
const VALID_ROLES = new Set(['system', 'user', 'assistant']);

interface ValidationResult {
	valid: boolean;
	reason?: number;
}

interface UpstreamChatResponse {
	choices?: Array<{ message?: { content?: unknown } }>;
}

const upstreamContent = (value: unknown): string => {
	if (!value || typeof value !== 'object') return '';
	const response = value as UpstreamChatResponse;
	const content = response.choices?.[0]?.message?.content;
	return typeof content === 'string' ? content : '';
};

export const isAbortError = (error: unknown): boolean =>
	error instanceof Error && error.name === 'AbortError';

/**
 * 漏洞1+8: 消息深度校验
 * 校验 messages 数组中每条消息的 role 和 content 合法性，并限制总长度
 * 防止 Prompt 注入和超大请求消耗 token
 */
export const validateMessages = (messages: unknown): ValidationResult => {
	if (!Array.isArray(messages) || messages.length === 0) {
		return { valid: false, reason: CommonStatus.PARAM_ERR };
	}
	if (messages.length > MAX_MESSAGES_COUNT) {
		return { valid: false, reason: AssistantStatus.CONTENT_TOO_LONG };
	}
	for (const msg of messages) {
		if (!msg || typeof msg !== 'object') {
			return { valid: false, reason: AssistantStatus.INVALID_MESSAGE };
		}
		const m = msg as { role?: unknown; content?: unknown };
		if (typeof m.role !== 'string' || !VALID_ROLES.has(m.role)) {
			return { valid: false, reason: AssistantStatus.INVALID_MESSAGE };
		}
		if (typeof m.content !== 'string' || m.content.length === 0) {
			return { valid: false, reason: AssistantStatus.INVALID_MESSAGE };
		}
		if (m.content.length > MAX_MESSAGE_LENGTH) {
			return { valid: false, reason: AssistantStatus.CONTENT_TOO_LONG };
		}
	}
	return { valid: true };
};

/**
 * 漏洞3: 基于 Redis 的限流（每用户每分钟最多 20 次）
 * 使用 INCR + EXPIRE 实现滑动窗口，支持集群部署
 * Redis 不可用时降级到内存限流
 */
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_PER_MIN = 20;

export const checkRateLimit = async (userId: number | string): Promise<boolean> => {
	const key = String(userId);
	try {
		const redisKey = `ai_rate:${key}`;
		const count = await better_chat.incr(redisKey);
		if (count === 1) {
			await better_chat.expire(redisKey, 60);
		}
		return count <= RATE_LIMIT_PER_MIN;
	} catch {
		// Redis 不可用时降级到内存限流
		const now = Date.now();
		const arr = (rateLimitMap.get(key) || []).filter(t => now - t < 60000);
		if (arr.length >= RATE_LIMIT_PER_MIN) return false;
		arr.push(now);
		rateLimitMap.set(key, arr);
		return true;
	}
};

/**
 * 漏洞2: 对 AI 返回内容做基本 sanitize
 * 移除 <script> 标签和 on* 事件处理器，作为纵深防御
 */
const sanitizeContent = (text: string): string => {
	return String(text)
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
		.replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
		.replace(/\son\w+\s*=\s*'[^']*'/gi, '')
		.replace(/javascript:/gi, '');
};

/**
 * 漏洞5: 创建带超时的 AbortController
 */
export const createTimeoutController = (): AbortController => {
	const controller = new AbortController();
	setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
	return controller;
};

/**
 * 漏洞7: 记录详细错误到日志，但返回通用消息给客户端
 */
export const logError = (fn: string, err: unknown): void => {
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`[assistant] ${fn} 异常:`, msg);
};

// 非流式聊天补全
export const chat = async (actor: Actor, parameters: ChatInput): Promise<Outcome> => {
	const { messages } = parameters || {};
	// 漏洞1+8: 深度校验消息
	const validation = validateMessages(messages);
	if (!validation.valid) {
		return failure(validation.reason!);
	}
	if (!API_KEY) {
		return failure(CommonStatus.SERVER_ERR);
	}
	// 漏洞3: Redis 限流
	if (!(await checkRateLimit(actor.id))) {
		return failure(AssistantStatus.RATE_LIMIT_ERR);
	}
	try {
		// 漏洞5: 添加超时；漏洞6: 忽略客户端 model，强制使用服务端配置
		const resp = await requestChatCompletion(messages, false, createTimeoutController().signal);
		if (!resp.ok) {
			const t = await resp.text().catch(() => '');
			console.error('[assistant] chat 上游错误:', resp.status, t);
			return failure(CommonStatus.SERVER_ERR);
		}
		const data: unknown = await resp.json();
		const text = upstreamContent(data);
		// 漏洞2: sanitize AI 返回内容
		return success({ content: sanitizeContent(text) });
	} catch (err: unknown) {
		// 漏洞7: 不泄露内部错误细节
		logError('chat', err);
		if (isAbortError(err)) {
			return failure(AssistantStatus.UPSTREAM_TIMEOUT);
		} else {
			return failure(CommonStatus.SERVER_ERR);
		}
	}
};

// 流式聊天补全（SSE 转发）

// 下一步建议
export const nextSteps = async (actor: Actor, parameters: NextStepsInput): Promise<Outcome> => {
	const { contextText, count = 5 } = parameters || {};
	if (!contextText || typeof contextText !== 'string') {
		return failure(CommonStatus.PARAM_ERR);
	}
	// 漏洞8: 限制 contextText 长度
	if (contextText.length > MAX_CONTEXT_LENGTH) {
		return failure(AssistantStatus.CONTENT_TOO_LONG);
	}
	if (!API_KEY) {
		return failure(CommonStatus.SERVER_ERR);
	}
	// 漏洞3: Redis 限流
	if (!(await checkRateLimit(actor.id))) {
		return failure(AssistantStatus.RATE_LIMIT_ERR);
	}
	const prompt = `基于以下最近的对话内容，给出不超过${count}条"下一步行动建议"，要求：\n1) 中文，简洁，每条不超过30字\n2) 可直接点击作为回复开头或行动声明\n3) 不要编号，按行返回\n\n对话：\n${contextText}`;
	try {
		// 漏洞5: 添加超时
		const resp = await requestChatCompletion(
			[{ role: 'user', content: prompt }],
			false,
			createTimeoutController().signal
		);
		if (!resp.ok) {
			return failure(CommonStatus.SERVER_ERR);
		}
		const data: unknown = await resp.json();
		const text = upstreamContent(data);
		// 漏洞2: sanitize AI 返回内容
		const lines = sanitizeContent(text)
			.split('\n')
			.map(s => s.trim().replace(/^[-•\d.\s]+/, ''))
			.filter(s => s.length > 0);
		return success({ steps: lines.slice(0, Number(count)) });
	} catch (err: unknown) {
		// 漏洞7: 不泄露内部错误细节
		logError('nextSteps', err);
		if (isAbortError(err)) {
			return failure(AssistantStatus.UPSTREAM_TIMEOUT);
		} else {
			return failure(CommonStatus.SERVER_ERR);
		}
	}
};
