import { MessageOverloadError, positiveSetting } from '../../shared/overload';
import { countMessageMetric, setMessageGauge } from '../../infrastructure/message-metrics';
export type ChatType = 'private' | 'group';
export type MediaType = 'text' | 'image' | 'video' | 'file';
export type UserId = number | string;

export const HISTORY_PAGE_SIZE = 30;
export const MAX_HISTORY_PAGE_SIZE = 80;
export const MAX_MESSAGE_LENGTH = 10000;

export const isChatType = (value: string): value is ChatType =>
	value === 'private' || value === 'group';
export const isMediaType = (value: unknown): value is MediaType =>
	value === 'text' || value === 'image' || value === 'video' || value === 'file';
export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

/**
 * Preserves message order within a room and prevents concurrent transactions
 * from racing on the conversation sequence row.
 */
export const createRoomWriteQueue = (
	limits = () => ({
		room: positiveSetting('MESSAGE_ROOM_QUEUE_MAX', 32),
		global: positiveSetting('MESSAGE_WRITE_QUEUE_MAX', 256)
	})
) => {
	const rooms = new Map<string, { tail: Promise<void>; count: number }>();
	let pending = 0;
	return <T>(room: string, task: () => Promise<T>): Promise<T> => {
		const state = rooms.get(room) || { tail: Promise.resolve(), count: 0 };
		const max = limits();
		if (state.count >= max.room || pending >= max.global) {
			countMessageMetric('pomelo_message_rejected_queue_full_total');
			throw new MessageOverloadError('queue_full');
		}
		state.count++;
		pending++;
		setMessageGauge('pomelo_message_write_queue_pending', pending);
		const result = state.tail.then(task);
		state.tail = result
			.then(
				() => undefined,
				() => undefined
			)
			.then(() => {
				state.count--;
				pending--;
				if (!state.count) rooms.delete(room);
				setMessageGauge('pomelo_message_write_queue_pending', pending);
			});
		rooms.set(room, state);
		return result;
	};
};
export const enqueueRoomWrite = createRoomWriteQueue();

export interface GroupMembershipRow {
	id: number;
}

export interface FriendMembershipRow {
	user_id: number;
}

export interface GroupMemberRow {
	user_id: number;
}

export interface HistoryMessageRow {
	id: number;
	client_msg_id: string | null;
	room_seq: number;
	sender_id: UserId;
	receiver_id: UserId;
	content: string;
	room: string;
	media_type: MediaType;
	file_size: number;
	created_at: Date | string;
	avatar: string | null;
}

export interface ChatListItem {
	receiver_id: number;
	name?: string | null;
	receiver_username?: string | null;
	avatar: string | null;
	room: string;
	updated_at: Date | string;
	unreadCount: number;
	lastMessage: string | null;
	type: MediaType;
}

export interface IncomingMessage {
	content: string;
	type?: unknown;
	fileSize?: unknown;
	clientMsgId?: unknown;
}

export interface InsertMessage {
	conversation_id?: number;
	client_msg_id?: string | null;
	room_seq?: number;
	sender_id: UserId;
	receiver_id: UserId;
	content: string;
	room: string;
	type: ChatType;
	media_type: MediaType;
	file_size: number;
	status: number;
}

export interface OutboundMessage {
	id?: number;
	client_msg_id?: string | null;
	room_seq?: number;
	sender_id: UserId;
	receiver_id: UserId;
	content: string;
	room?: string;
	avatar?: string | null;
	type?: MediaType;
	file_size?: number | string;
	created_at?: string;
}

export interface FanoutPayload {
	version?: 1;
	instanceId: string;
	room: string;
	message: OutboundMessage | ReadReceiptFrame;
	persistedAt?: number;
}

export interface ReadReceiptFrame {
	name: 'read_receipt';
	room: string;
	userId: UserId;
	roomSeq: number;
}
