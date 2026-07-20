/**
 * AI 助手后端代理服务
 * H4/M10: 将 DeepSeek API Key 移至后端，前端不再暴露密钥
 * 密钥从环境变量读取：DEEPSEEK_API_KEY
 */
import type { Request, Response } from 'express';

import { CommonStatus, AssistantStatus } from '../../utils/status';
import { RespData, RespError } from '../../utils/resp';
import { better_chat } from '../../utils/authenticate';

const API_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

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

/**
 * 漏洞1+8: 消息深度校验
 * 校验 messages 数组中每条消息的 role 和 content 合法性，并限制总长度
 * 防止 Prompt 注入和超大请求消耗 token
 */
const validateMessages = (messages: unknown): ValidationResult => {
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

const checkRateLimit = async (userId: number | string): Promise<boolean> => {
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
const createTimeoutController = (): AbortController => {
	const controller = new AbortController();
	setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
	return controller;
};

/**
 * 漏洞7: 记录详细错误到日志，但返回通用消息给客户端
 */
const logError = (fn: string, err: unknown): void => {
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`[assistant] ${fn} 异常:`, msg);
};

// 非流式聊天补全
export const chat = async (req: Request, res: Response): Promise<void> => {
	const { messages } = req.body || {};
	// 漏洞1+8: 深度校验消息
	const validation = validateMessages(messages);
	if (!validation.valid) {
		RespError(res, validation.reason!);
		return;
	}
	if (!API_KEY) {
		RespError(res, CommonStatus.SERVER_ERR);
		return;
	}
	// 漏洞3: Redis 限流
	if (!(await checkRateLimit(req.user!.id))) {
		RespError(res, AssistantStatus.RATE_LIMIT_ERR);
		return;
	}
	try {
		// 漏洞5: 添加超时；漏洞6: 忽略客户端 model，强制使用服务端配置
		const resp = await fetch(`${API_BASE}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${API_KEY}`
			},
			body: JSON.stringify({
				model: MODEL,
				messages,
				stream: false
			}),
			signal: createTimeoutController().signal
		});
		if (!resp.ok) {
			const t = await resp.text().catch(() => '');
			console.error('[assistant] chat 上游错误:', resp.status, t);
			RespError(res, CommonStatus.SERVER_ERR);
			return;
		}
		const data: any = await resp.json();
		const text = data?.choices?.[0]?.message?.content || '';
		// 漏洞2: sanitize AI 返回内容
		RespData(res, { content: sanitizeContent(text) });
	} catch (err: any) {
		// 漏洞7: 不泄露内部错误细节
		logError('chat', err);
		if (err?.name === 'AbortError') {
			RespError(res, AssistantStatus.UPSTREAM_TIMEOUT);
		} else {
			RespError(res, CommonStatus.SERVER_ERR);
		}
	}
};

// 流式聊天补全（SSE 转发）
export const chatStream = async (req: Request, res: Response): Promise<void> => {
	const { messages } = req.body || {};
	// 漏洞1+8: 深度校验消息
	const validation = validateMessages(messages);
	if (!validation.valid) {
		RespError(res, validation.reason!);
		return;
	}
	if (!API_KEY) {
		RespError(res, CommonStatus.SERVER_ERR);
		return;
	}
	// 漏洞3: Redis 限流
	if (!(await checkRateLimit(req.user!.id))) {
		RespError(res, AssistantStatus.RATE_LIMIT_ERR);
		return;
	}
	// SSE 响应头
	res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders();

	// 漏洞5: 带超时的 controller
	const controller = createTimeoutController();

	// 漏洞4: 监听客户端断开，中止上游请求
	const onClientClose = () => controller.abort();
	res.on('close', onClientClose);

	try {
		// 漏洞6: 忽略客户端 model
		const resp = await fetch(`${API_BASE}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${API_KEY}`
			},
			body: JSON.stringify({
				model: MODEL,
				messages,
				stream: true
			}),
			signal: controller.signal
		});
		if (!resp.ok || !resp.body) {
			// 漏洞7: 返回通用错误，不泄露上游细节
			res.write(`data: ${JSON.stringify({ error: 'upstream error' })}\n\n`);
			res.end();
			return;
		}
		const reader = resp.body.getReader();
		const dec = new TextDecoder('utf-8');
		let done = false;
		while (!done) {
			const { value, done: readerDone } = await reader.read();
			done = readerDone as boolean;
			if (value) {
				res.write(dec.decode(value, { stream: true }));
			}
		}
		res.end();
	} catch (err: any) {
		// 漏洞7: 不泄露 err.message
		logError('chatStream', err);
		if (err?.name === 'AbortError') {
			// 可能是客户端断开或超时，静默结束
			res.end();
		} else {
			res.write(`data: ${JSON.stringify({ error: 'internal error' })}\n\n`);
			res.end();
		}
	} finally {
		res.removeListener('close', onClientClose);
	}
};

// 下一步建议
export const nextSteps = async (req: Request, res: Response): Promise<void> => {
	const { contextText, count = 5 } = req.body || {};
	if (!contextText || typeof contextText !== 'string') {
		RespError(res, CommonStatus.PARAM_ERR);
		return;
	}
	// 漏洞8: 限制 contextText 长度
	if (contextText.length > MAX_CONTEXT_LENGTH) {
		RespError(res, AssistantStatus.CONTENT_TOO_LONG);
		return;
	}
	if (!API_KEY) {
		RespError(res, CommonStatus.SERVER_ERR);
		return;
	}
	// 漏洞3: Redis 限流
	if (!(await checkRateLimit(req.user!.id))) {
		RespError(res, AssistantStatus.RATE_LIMIT_ERR);
		return;
	}
	const prompt = `基于以下最近的对话内容，给出不超过${count}条"下一步行动建议"，要求：\n1) 中文，简洁，每条不超过30字\n2) 可直接点击作为回复开头或行动声明\n3) 不要编号，按行返回\n\n对话：\n${contextText}`;
	try {
		// 漏洞5: 添加超时
		const resp = await fetch(`${API_BASE}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${API_KEY}`
			},
			body: JSON.stringify({
				model: MODEL,
				messages: [{ role: 'user', content: prompt }],
				stream: false
			}),
			signal: createTimeoutController().signal
		});
		if (!resp.ok) {
			RespError(res, CommonStatus.SERVER_ERR);
			return;
		}
		const data: any = await resp.json();
		const text = data?.choices?.[0]?.message?.content || '';
		// 漏洞2: sanitize AI 返回内容
		const lines = sanitizeContent(text)
			.split('\n')
			.map(s => s.trim().replace(/^[-•\d.\s]+/, ''))
			.filter(s => s.length > 0);
		RespData(res, { steps: lines.slice(0, count) });
	} catch (err: any) {
		// 漏洞7: 不泄露内部错误细节
		logError('nextSteps', err);
		if (err?.name === 'AbortError') {
			RespError(res, AssistantStatus.UPSTREAM_TIMEOUT);
		} else {
			RespError(res, CommonStatus.SERVER_ERR);
		}
	}
};
