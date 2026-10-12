import type { IMessageItem } from '@/components/MessageShow/type';

export const mergeMessages = (
	previous: IMessageItem[],
	incoming: IMessageItem[]
): IMessageItem[] => {
	const result = [...previous];
	for (const item of incoming) {
		const clientId = item.client_msg_id || item.clientMsgId;
		const index = result.findIndex(
			old =>
				(item.id !== undefined && item.id !== null && old.id === item.id) ||
				(clientId &&
					String(old.sender_id) === String(item.sender_id) &&
					(old.client_msg_id || old.clientMsgId) === clientId)
		);
		if (index < 0) result.push(item);
		else {
			const old = result[index];
			const merged = { ...old, ...item, clientMsgId: clientId || old.clientMsgId };
			if (old.status === 'sent' || item.status === 'sent') {
				merged.status = 'sent';
				merged.failureReason = undefined;
			}
			result[index] = merged;
		}
	}
	return result.sort((a, b) => {
		if (a.room_seq && b.room_seq) return a.room_seq - b.room_seq;
		if (a.room_seq) return -1;
		if (b.room_seq) return 1;
		return 0;
	});
};
