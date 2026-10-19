import * as repository from './repository';
import type { SqlQuery } from '../../shared/actor';
import { lockOwnedFile } from '../files/public';

export interface PersistedMessage {
	file_name?: string | null;
	sender_id: number | string;
	receiver_id: number | string;
	content: string;
	room: string;
	type: 'private' | 'group';
	media_type: 'text' | 'image' | 'video' | 'file';
	file_size: number;
	status: number;
	client_msg_id?: string | null;
	conversation_id?: number;
	room_seq?: number;
}

/** Shared by ordinary messages and group initialization, inside the caller's transaction. */
export const persistMessage = async (
	query: SqlQuery,
	msg: PersistedMessage,
	lockedConversation?: { id: number; last_seq: number }
): Promise<number> => {
	if (!lockedConversation)
		await repository.ensureConversation([msg.room, msg.type, msg.receiver_id], query);
	const rows = lockedConversation
		? [lockedConversation]
		: await repository.lockConversationSequence<Array<{ id: number; last_seq: number }>>(
				[msg.room],
				query
			);
	if (!rows.length) throw new Error('Conversation not found');
	msg.conversation_id = rows[0].id;
	msg.room_seq = Number(rows[0].last_seq) + 1;
	const result = await repository.insertMessage<{ insertId: number }>(msg, query);
	if (msg.media_type !== 'text') {
		const attachment = await lockOwnedFile(query, msg.sender_id, msg.content, msg.media_type);
		await repository.insertMessageAttachment([result.insertId, attachment.fileId], query);
		msg.file_size = attachment.size;
		await repository.updateMessageFileSize([msg.file_size, result.insertId], query);
	}
	await repository.advanceConversation([msg.room_seq, result.insertId, msg.conversation_id], query);
	if (lockedConversation) {
		const statistics = await repository.incrementExistingMessageStatistics<{
			affectedRows: number;
		}>([msg.room], query);
		if (statistics.affectedRows !== 1) throw new Error('Message statistics missing');
	} else await repository.incrementMessageStatistics([msg.room], query);
	await repository.insertMessageOutbox([result.insertId, msg.conversation_id], query);
	return result.insertId;
};
