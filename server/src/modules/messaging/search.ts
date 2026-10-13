import * as readModel from '../../read-models/messaging';
import { authorizeChatRoom } from '../social/public';
import type { ChatType, HistoryMessageRow, UserId } from './contracts';

export interface SearchOptions {
	query?: string;
	since?: string;
	until?: string;
	senderId?: number;
	mediaType?: 'text' | 'image' | 'video' | 'file';
	beforeId?: number;
	afterId?: number;
	limit?: number;
}
export interface SearchRow extends HistoryMessageRow {
	sender_username: string;
	sender_name: string;
	type: ChatType;
}

export const validDate = (value: string) =>
	/^\d{4}-\d{2}-\d{2}$/.test(value) &&
	!Number.isNaN(Date.parse(`${value}T00:00:00+08:00`)) &&
	new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const validateSearch = (options: SearchOptions) => {
	if ((options.query?.length || 0) > 100) throw new Error('invalid query');
	for (const date of [options.since, options.until])
		if (date && !validDate(date)) throw new Error('invalid date');
	if (options.since && options.until && options.since > options.until)
		throw new Error('invalid range');
	for (const id of [options.senderId, options.beforeId, options.afterId])
		if (id !== undefined && (!Number.isSafeInteger(id) || id < 1)) throw new Error('invalid id');
	if (
		options.limit !== undefined &&
		(!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 50)
	)
		throw new Error('invalid limit');
	if (options.mediaType && !['text', 'image', 'video', 'file'].includes(options.mediaType))
		throw new Error('invalid media');
	if (options.query && options.mediaType && options.mediaType !== 'text')
		throw new Error('invalid keyword/media combination');
};
export const searchRoomMessages = async (
	userId: UserId,
	room: string,
	type: ChatType,
	options: SearchOptions
) => {
	validateSearch(options);
	if (!(await authorizeChatRoom(userId, room, type))) return null;
	const conditions = ['m.room = ?', 'm.type = ?'];
	const values: unknown[] = [room, type];
	const keyword = options.query?.trim();
	if (keyword) {
		conditions.push("m.media_type = 'text'", "m.content LIKE ? ESCAPE '!'");
		values.push(`%${keyword.replace(/[!%_]/g, value => `!${value}`)}%`);
	}
	if (options.mediaType) {
		conditions.push('m.media_type = ?');
		values.push(options.mediaType);
	}
	if (options.senderId) {
		conditions.push('m.sender_id = ?');
		values.push(options.senderId);
	}
	// CURRENT_TIMESTAMP-backed DATETIME follows the DB session clock. Convert
	// Shanghai date boundaries to that clock without applying functions to the index column.
	const shanghaiBoundary =
		'TIMESTAMPADD(SECOND, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) - 28800, ?)';
	if (options.since) {
		conditions.push(`m.created_at >= ${shanghaiBoundary}`);
		values.push(`${options.since} 00:00:00`);
	}
	if (options.until) {
		conditions.push(`m.created_at < DATE_ADD(${shanghaiBoundary}, INTERVAL 1 DAY)`);
		values.push(`${options.until} 00:00:00`);
	}
	if (options.beforeId) {
		conditions.push('m.id < ?');
		values.push(options.beforeId);
	}
	if (options.afterId) {
		conditions.push('m.id > ?');
		values.push(options.afterId);
	}
	const limit = options.limit || 20;
	const rows = await readModel.searchMessagesInRoom<SearchRow[]>([...values, limit + 1], {
		conditions,
		options
	});
	const messages = rows.slice(0, limit);
	return { messages, hasMore: rows.length > limit, nextBeforeId: messages.at(-1)?.id };
};
export const contextRoomMessages = async (
	userId: UserId,
	room: string,
	type: ChatType,
	messageId: number,
	before = 20,
	after = 20
) => {
	if (!(await authorizeChatRoom(userId, room, type))) return null;
	const target = await readModel.findMessageInRoom<SearchRow[]>([room, type, messageId]);
	if (!target.length) return null;
	const nearby = (operator: '<' | '>', count: number) =>
		readModel.listNearbyMessages<SearchRow[]>([room, type, messageId, count + 1], { operator });
	const [older, newer] = await Promise.all([nearby('<', before), nearby('>', after)]);
	const messages = [...older.slice(0, before).reverse(), target[0], ...newer.slice(0, after)];
	return {
		messages,
		focusId: messageId,
		hasBefore: older.length > before,
		hasAfter: newer.length > after,
		nextBeforeId: messages[0].id,
		nextAfterId: messages.at(-1)!.id
	};
};
export const resolveRoomMessages = async (
	userId: UserId,
	room: string,
	type: ChatType,
	ids: string[]
) => {
	if (!(await authorizeChatRoom(userId, room, type))) return null;
	if (!ids.length) return [];
	return readModel.resolveOwnedMessageIds<SearchRow[]>([room, type, userId, ...ids], { ids });
};

export const recentRoomMessages = async (
	userId: UserId,
	room: string,
	type: ChatType,
	limit = 30
) => {
	if (!(await authorizeChatRoom(userId, room, type))) return [];
	const rows = await readModel.listRecentMessages<SearchRow[]>([
		room,
		type,
		Math.max(1, Math.min(Math.floor(limit) || 30, 80))
	]);
	return rows.reverse();
};

export const messageContextById = async (
	userId: UserId,
	messageId: number,
	before = 3,
	after = 3
) => {
	const target = await readModel.findMessageContextTarget<SearchRow[]>([messageId]);
	const row = target[0];
	if (!row) return null;
	const result = await contextRoomMessages(userId, row.room, row.type, messageId, before, after);
	return result ? { ...result, room: row.room } : null;
};
