const roomWriteTails = new Map<string, Promise<void>>();
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
export const enqueueRoomWrite = <T>(room: string, task: () => Promise<T>): Promise<T> => {
	const previous = roomWriteTails.get(room) || Promise.resolve();
	const result = previous.catch(() => undefined).then(task);
	const tail = result.then(
		() => undefined,
		() => undefined
	);
	roomWriteTails.set(room, tail);
	void tail.finally(() => {
		if (roomWriteTails.get(room) === tail) roomWriteTails.delete(room);
	});
	return result;
};

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
	instanceId: string;
	room: string;
	message: OutboundMessage | ReadReceiptFrame;
}

export interface ReadReceiptFrame {
	name: 'read_receipt';
	room: string;
	userId: UserId;
	roomSeq: number;
}
