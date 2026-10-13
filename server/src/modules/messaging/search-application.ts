import type { Actor } from '../../shared/actor';
import { success, failure, type Outcome } from '../../shared/outcome';
import { CommonStatus } from '../../shared/status';
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
	(fn: (actor: Actor, parameters: Record<string, unknown>) => Promise<Outcome>) =>
	async (
		actor: Actor,
		parameters: Record<string, unknown>,
		_authorization?: string
	): Promise<Outcome> => {
		try {
			return await fn(actor, parameters);
		} catch (error) {
			console.error('[message:query]', error instanceof Error ? error.message : String(error));
			return failure(
				error instanceof Error && error.message.startsWith('invalid')
					? CommonStatus.PARAM_ERR
					: CommonStatus.SERVER_ERR
			);
		}
	};
export const searchMessages = handle(async (actor, parameters) => {
	const { room, type } = roomParams(parameters);
	const options: SearchOptions = {
		query: optionalText(parameters.query),
		since: optionalText(parameters.since),
		until: optionalText(parameters.until),
		mediaType: optionalText(parameters.mediaType) as SearchOptions['mediaType']
	};
	for (const key of ['senderId', 'beforeId', 'afterId', 'limit'] as const)
		if (parameters[key] !== undefined) options[key] = Number(parameters[key]);
	validateSearch(options);
	const result = await searchRoomMessages(actor.id, room, type, options);
	if (!result) return failure(CommonStatus.NOT_FOUND);
	return success({
		...result,
		messages: formatHistoryMessages(result.messages).map((message, index) => ({
			...message,
			sender_name: result.messages[index].sender_name || result.messages[index].sender_username
		}))
	});
});
export const getMessageContext = handle(async (actor, parameters) => {
	const { room, type } = roomParams(parameters);
	const messageId = Number(parameters.messageId);
	if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('invalid message id');
	const result = await contextRoomMessages(actor.id, room, type, messageId);
	if (!result) return failure(CommonStatus.NOT_FOUND);
	return success({ ...result, messages: formatHistoryMessages(result.messages) });
});
export const resolveMessages = handle(async (actor, parameters) => {
	const { room, type } = roomParams(parameters || {});
	const ids: unknown = parameters.clientMsgIds;
	if (
		!Array.isArray(ids) ||
		ids.length > 100 ||
		ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(id))
	)
		throw new Error('invalid client message ids');
	const result = await resolveRoomMessages(actor.id, room, type, [...new Set(ids as string[])]);
	if (!result) return failure(CommonStatus.NOT_FOUND);
	return success({ messages: formatHistoryMessages(result) });
});
