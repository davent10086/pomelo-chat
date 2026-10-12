import type { Request, Response } from 'express';
import { CommonStatus } from '../../utils/status';
import { RespData, RespError } from '../../utils/resp';
import { isChatType } from './contracts';
import { formatHistoryMessages } from './queries';
import {
	searchRoomMessages,
	contextRoomMessages,
	resolveRoomMessages,
	validateSearch,
	type SearchOptions
} from './search';

const roomParams = (source: Record<string, unknown>) => {
	const room = typeof source.room === 'string' ? source.room : '';
	const type = typeof source.type === 'string' && isChatType(source.type) ? source.type : undefined;
	if (!room || room.length > 128 || !type) throw new Error('invalid room');
	return { room, type };
};
const optionalText = (value: unknown) => {
	if (value === undefined || value === '') return undefined;
	if (typeof value !== 'string') throw new Error('invalid text');
	return value.trim();
};
const handle =
	(fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
		try {
			await fn(req, res);
		} catch (error) {
			console.error('[message:query]', error instanceof Error ? error.message : String(error));
			RespError(
				res,
				error instanceof Error && error.message.startsWith('invalid')
					? CommonStatus.PARAM_ERR
					: CommonStatus.SERVER_ERR
			);
		}
	};
export const searchMessages = handle(async (req, res) => {
	const { room, type } = roomParams(req.query);
	const options: SearchOptions = {
		query: optionalText(req.query.query),
		since: optionalText(req.query.since),
		until: optionalText(req.query.until),
		mediaType: optionalText(req.query.mediaType) as SearchOptions['mediaType']
	};
	for (const key of ['senderId', 'beforeId', 'afterId', 'limit'] as const)
		if (req.query[key] !== undefined) options[key] = Number(req.query[key]);
	validateSearch(options);
	const result = await searchRoomMessages(req.user!.id, room, type, options);
	if (!result) return RespError(res, CommonStatus.NOT_FOUND);
	RespData(res, {
		...result,
		messages: formatHistoryMessages(result.messages).map((message, index) => ({
			...message,
			sender_name: result.messages[index].sender_name || result.messages[index].sender_username
		}))
	});
});
export const getMessageContext = handle(async (req, res) => {
	const { room, type } = roomParams(req.query);
	const messageId = Number(req.query.messageId);
	if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('invalid message id');
	const result = await contextRoomMessages(req.user!.id, room, type, messageId);
	if (!result) return RespError(res, CommonStatus.NOT_FOUND);
	RespData(res, { ...result, messages: formatHistoryMessages(result.messages) });
});
export const resolveMessages = handle(async (req, res) => {
	const { room, type } = roomParams(req.body || {});
	const ids: unknown = req.body?.clientMsgIds;
	if (
		!Array.isArray(ids) ||
		ids.length > 100 ||
		ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(id))
	)
		throw new Error('invalid client message ids');
	const result = await resolveRoomMessages(req.user!.id, room, type, [...new Set(ids as string[])]);
	if (!result) return RespError(res, CommonStatus.NOT_FOUND);
	RespData(res, { messages: formatHistoryMessages(result) });
});
