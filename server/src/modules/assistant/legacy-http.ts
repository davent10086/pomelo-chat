import { requestChatCompletion } from './adapters/legacy-model';
import type { Request, Response } from 'express';
import { CommonStatus, AssistantStatus } from '../../shared/status';
import { RespError } from '../../infrastructure/http-response';
import {
	validateMessages,
	API_KEY,
	checkRateLimit,
	createTimeoutController,
	logError,
	isAbortError
} from './legacy-application';
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
		const resp = await requestChatCompletion(messages, true, controller.signal);
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
	} catch (err: unknown) {
		// 漏洞7: 不泄露 err.message
		logError('chatStream', err);
		if (isAbortError(err)) {
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
