import type { Request, Response } from 'express';
import { RespError } from '../../infrastructure/http-response';
import { CommonStatus, AssistantStatus } from '../../shared/status';
import {
	MAX_INPUT_LENGTH,
	API_KEY,
	checkRateLimit,
	normalizeAgentRequest,
	runLangChainAgent
} from './agent';
export const agentStream = async (req: Request, res: Response): Promise<void> => {
	const { input, room, context } = req.body || {};
	if (!input || typeof input !== 'string' || input.length > MAX_INPUT_LENGTH) {
		RespError(
			res,
			input?.length > MAX_INPUT_LENGTH ? AssistantStatus.CONTENT_TOO_LONG : CommonStatus.PARAM_ERR
		);
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
	const controller = new AbortController();
	const onClientClose = () => controller.abort();
	res.once('close', onClientClose);
	try {
		const userId = Number(req.user!.id);
		if (!Number.isFinite(userId)) {
			res.write(`data: ${JSON.stringify({ error: 'token error' })}\n\n`);
			res.end();
			return;
		}
		const request = normalizeAgentRequest(room, context);
		const result = await runLangChainAgent(
			userId,
			input,
			request.room,
			request.context,
			event => {
				if (!res.writableEnded) res.write(`event: agent\ndata: ${JSON.stringify(event)}\n\n`);
			},
			controller.signal,
			(delta, reset) => {
				if (!res.writableEnded)
					res.write(`event: delta\ndata: ${JSON.stringify({ delta, reset })}\n\n`);
			}
		);
		res.write(`data: ${JSON.stringify(result)}\n\n`);
		res.write('data: [DONE]\n\n');
		res.end();
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[assistant-agent] agentStream 异常:', err.message);
		if (!controller.signal.aborted) {
			res.write(`data: ${JSON.stringify({ error: 'internal error' })}\n\n`);
			res.end();
		}
	} finally {
		res.removeListener('close', onClientClose);
	}
};
