export interface GetHistoryInput {
	room?: unknown;
	type?: unknown;
	beforeId?: unknown;
	limit?: unknown;
	afterSeq?: unknown;
}
export interface MarkReadInput {
	room?: unknown;
	type?: unknown;
	roomSeq?: unknown;
}
import * as readModel from '../../read-models/messaging';
import type { Actor } from '../../shared/actor';
import { success, failure, type Outcome } from '../../shared/outcome';
import { CommonStatus } from '../../shared/status';
import { authorizeChatRoom } from './permissions';
import { fetchHistoryMessages, markRoomRead } from './queries';
import { HISTORY_PAGE_SIZE, isChatType, type ChatListItem } from './contracts';
import { findForwardSource, lockRecallSource, retractMessage } from './repository';
import { withTransaction } from '../../infrastructure/database-query';
import { sendConfirmedTextMessage } from './writes';
import { MessageOverloadError } from '../../shared/overload';

export const forwardMessage = async (actor: Actor, input: Record<string, unknown>): Promise<Outcome> => {
	const id = Number(input.sourceId), room = input.room, type = input.type, clientMsgId = input.clientMsgId;
	if (typeof input.sourceId !== 'number' || !Number.isSafeInteger(id) || id < 1 || typeof room !== 'string' || !room || room.length > 128 ||
		typeof type !== 'string' || !isChatType(type) || typeof clientMsgId !== 'string' || !/^[a-zA-Z0-9_-]{8,48}$/.test(clientMsgId)) return failure(CommonStatus.PARAM_ERR);
	try {
		const [source] = await findForwardSource(id);
		if (!source || source.recalled_at || source.media_type !== 'text' || !await authorizeChatRoom(actor.id, source.room, source.type) ||
			!await authorizeChatRoom(actor.id, room, type)) return failure(CommonStatus.UNAUTHORIZED);
		await sendConfirmedTextMessage(Number(actor.id), room, type, source.content, `forward_${clientMsgId}`);
		return success();
	} catch (error) {
		if (error instanceof MessageOverloadError) throw error;
		console.error('[message] forward failed:', error);
		return failure(CommonStatus.SERVER_ERR);
	}
};

export const recallMessage = async (actor: Actor, input: Record<string, unknown>): Promise<Outcome> => {
	const id = Number(input.messageId), room = input.room, type = input.type;
	if (typeof input.messageId !== 'number' || !Number.isSafeInteger(id) || id < 1 || typeof room !== 'string' || !room || room.length > 128 || typeof type !== 'string' || !isChatType(type)) return failure(CommonStatus.PARAM_ERR);
	try {
		if (!await authorizeChatRoom(actor.id, room, type)) return failure(CommonStatus.UNAUTHORIZED);
		return await withTransaction(async query => {
			const [source] = await lockRecallSource(id, query);
			if (!source || Number(source.sender_id) !== Number(actor.id) || source.room !== room || source.type !== type) return failure(CommonStatus.UNAUTHORIZED);
			if (source.recalled_at) return success();
			if (Number(source.eligible) !== 1) return failure(CommonStatus.PARAM_ERR);
			await retractMessage(id, query);
			return success();
		});
	} catch { return failure(CommonStatus.SERVER_ERR); }
};
export const getChatList = async (actor: Actor): Promise<Outcome> => {
	try {
		const data: ChatListItem[] = [];
		const id = actor.id;

		data.push(...(await readModel.listPrivateChatSummaries<ChatListItem[]>([id, id])));

		data.push(...(await readModel.listGroupChatSummaries<ChatListItem[]>([id, id])));
		data.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
		return success(data);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[message] getChatList error:', message);
		return failure(CommonStatus.SERVER_ERR);
	}
};

export const getHistory = async (actor: Actor, parameters: GetHistoryInput): Promise<Outcome> => {
	const room = typeof parameters.room === 'string' ? parameters.room : '';
	const type =
		typeof parameters.type === 'string' && isChatType(parameters.type) ? parameters.type : null;
	const beforeId = parameters.beforeId ? Number(parameters.beforeId) : undefined;
	const limit = parameters.limit ? Number(parameters.limit) : HISTORY_PAGE_SIZE;
	const afterSeq = parameters.afterSeq !== undefined ? Number(parameters.afterSeq) : undefined;
	if (
		!room ||
		!type ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		(beforeId !== undefined && (!Number.isSafeInteger(beforeId) || beforeId < 1)) ||
		(afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0))
	)
		return failure(CommonStatus.PARAM_ERR);
	try {
		const result = await fetchHistoryMessages(actor.id, room, type, beforeId, limit, afterSeq);
		if (!result) return failure(CommonStatus.UNAUTHORIZED);
		return success({
			messages: result.messages,
			peerReadSeq: result.peerReadSeq,
			hasMore: result.hasMore,
			nextBeforeId: result.nextBeforeId
			, nextAfterSeq: result.nextAfterSeq
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[message] getHistory error:', message);
		return failure(CommonStatus.SERVER_ERR);
	}
};

export const markRead = async (actor: Actor, parameters: MarkReadInput): Promise<Outcome> => {
	const room = typeof parameters.room === 'string' ? parameters.room : '';
	const type =
		typeof parameters.type === 'string' && isChatType(parameters.type) ? parameters.type : null;
	const roomSeq = Number(parameters.roomSeq);
	if (!room || !type || !Number.isSafeInteger(roomSeq) || roomSeq < 0)
		return failure(CommonStatus.PARAM_ERR);
	try {
		const authorized = await authorizeChatRoom(actor.id, room, type);
		if (!authorized) return failure(CommonStatus.UNAUTHORIZED);
		const actualSeq = await markRoomRead(actor.id, room, type, roomSeq);
		return success({ room, read: true, roomSeq: actualSeq });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[message] markRead error:', message);
		return failure(CommonStatus.SERVER_ERR);
	}
};
