/**
 * AI 助手后端代理服务
 * H4/M10: 将 DeepSeek API Key 移至后端，前端不再暴露密钥
 * 密钥从环境变量读取：DEEPSEEK_API_KEY
 */
const { CommonStatus } = require('../../utils/status');
const { RespData, RespError } = require('../../utils/resp');

const API_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

// 简单的内存限流：每用户每分钟最多 20 次请求
const rateLimitMap = new Map();
const RATE_LIMIT_PER_MIN = 20;
const checkRateLimit = (userId) => {
	const now = Date.now();
	const key = String(userId);
	const arr = (rateLimitMap.get(key) || []).filter(t => now - t < 60000);
	if (arr.length >= RATE_LIMIT_PER_MIN) return false;
	arr.push(now);
	rateLimitMap.set(key, arr);
	return true;
};

// 非流式聊天补全
const chat = async (req, res) => {
	const { messages, model } = req.body;
	if (!Array.isArray(messages) || messages.length === 0) {
		return RespError(res, CommonStatus.PARAM_ERR);
	}
	if (!API_KEY) {
		return RespError(res, CommonStatus.SERVER_ERR);
	}
	if (!checkRateLimit(req.user.id)) {
		return RespError(res, CommonStatus.SERVER_ERR);
	}
	try {
		const resp = await fetch(`${API_BASE}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${API_KEY}`
			},
			body: JSON.stringify({
				model: model || MODEL,
				messages,
				stream: false
			})
		});
		if (!resp.ok) {
			const t = await resp.text().catch(() => '');
			console.error('[assistant] chat 失败:', resp.status, t);
			return RespError(res, CommonStatus.SERVER_ERR);
		}
		const data = await resp.json();
		const text = data?.choices?.[0]?.message?.content || '';
		return RespData(res, { content: String(text) });
	} catch (err) {
		console.error('[assistant] chat 异常:', err.message);
		return RespError(res, CommonStatus.SERVER_ERR);
	}
};

// 流式聊天补全（SSE 转发）
const chatStream = async (req, res) => {
	const { messages, model } = req.body;
	if (!Array.isArray(messages) || messages.length === 0) {
		return RespError(res, CommonStatus.PARAM_ERR);
	}
	if (!API_KEY) {
		return RespError(res, CommonStatus.SERVER_ERR);
	}
	if (!checkRateLimit(req.user.id)) {
		return RespError(res, CommonStatus.SERVER_ERR);
	}
	// SSE 响应头
	res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders();
	try {
		const resp = await fetch(`${API_BASE}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${API_KEY}`
			},
			body: JSON.stringify({
				model: model || MODEL,
				messages,
				stream: true
			})
		});
		if (!resp.ok || !resp.body) {
			res.write(`data: ${JSON.stringify({ error: 'upstream error' })}\n\n`);
			res.end();
			return;
		}
		const reader = resp.body.getReader();
		const decoder = require('util').TextDecoder || global.TextDecoder;
		const dec = new decoder('utf-8');
		let done = false;
		while (!done) {
			const { value, done: readerDone } = await reader.read();
			done = readerDone;
			if (value) {
				res.write(dec.decode(value, { stream: true }));
			}
		}
		res.end();
	} catch (err) {
		console.error('[assistant] chatStream 异常:', err.message);
		res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
		res.end();
	}
};

// 下一步建议
const nextSteps = async (req, res) => {
	const { contextText, count = 5 } = req.body;
	if (!contextText) {
		return RespError(res, CommonStatus.PARAM_ERR);
	}
	if (!API_KEY) {
		return RespError(res, CommonStatus.SERVER_ERR);
	}
	if (!checkRateLimit(req.user.id)) {
		return RespError(res, CommonStatus.SERVER_ERR);
	}
	const prompt = `基于以下最近的对话内容，给出不超过${count}条"下一步行动建议"，要求：\n1) 中文，简洁，每条不超过30字\n2) 可直接点击作为回复开头或行动声明\n3) 不要编号，按行返回\n\n对话：\n${contextText}`;
	try {
		const resp = await fetch(`${API_BASE}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${API_KEY}`
			},
			body: JSON.stringify({
				model: MODEL,
				messages: [{ role: 'user', content: prompt }],
				stream: false
			})
		});
		if (!resp.ok) {
			return RespError(res, CommonStatus.SERVER_ERR);
		}
		const data = await resp.json();
		const text = data?.choices?.[0]?.message?.content || '';
		const lines = String(text).split('\n').map(s => s.trim().replace(/^[-•\d.\s]+/, '')).filter(s => s.length > 0);
		return RespData(res, { steps: lines.slice(0, count) });
	} catch (err) {
		console.error('[assistant] nextSteps 异常:', err.message);
		return RespError(res, CommonStatus.SERVER_ERR);
	}
};

module.exports = {
	chat,
	chatStream,
	nextSteps
};
