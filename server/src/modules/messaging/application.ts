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
