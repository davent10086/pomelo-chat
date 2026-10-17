import type { IMessageItem } from '@/components/MessageShow/type';

/** A cursor only acknowledges persisted outgoing messages in its own room. */
export const withReadState = (
	messages: IMessageItem[],
	room: string | undefined,
	userId: number,
	sequence: number
): IMessageItem[] =>
	messages.map(message => ({
		...message,
		read:
			message.room === room &&
			Number(message.sender_id) === Number(userId) &&
			message.status !== 'pending' &&
			message.status !== 'failed' &&
			Number(message.room_seq) > 0 &&
			Number(message.room_seq) <= sequence
	}));
