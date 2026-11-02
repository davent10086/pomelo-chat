import type { IMessageItem } from '@/components/MessageShow/type';

export const mergeMessages = (
	previous: IMessageItem[],
	incoming: IMessageItem[]
): IMessageItem[] => {
	const result = [...previous];
	// Index both identities: an ACK can attach a server ID to a pending message.
	const byId = new Map<IMessageItem['id'], Set<number>>();
	const byClientId = new Map<string, Set<number>>();
	const clientKey = (item: IMessageItem) => {
		const id = item.client_msg_id || item.clientMsgId;
		return id ? JSON.stringify([String(item.sender_id), id]) : undefined;
	};
	const indexItem = (item: IMessageItem, index: number, remove = false) => {
		const update = <K,>(map: Map<K, Set<number>>, key: K) => {
			if (remove) {
				const positions = map.get(key);
				positions?.delete(index);
				if (!positions?.size) map.delete(key);
			} else {
				let positions = map.get(key);
				if (!positions) map.set(key, positions = new Set());
				positions.add(index);
			}
		};
		if (item.id !== undefined && item.id !== null) update(byId, item.id);
		const key = clientKey(item);
		if (key !== undefined) update(byClientId, key);
	};
	result.forEach((item, index) => indexItem(item, index));
	for (const item of incoming) {
		const clientId = item.client_msg_id || item.clientMsgId;
		let index = Infinity;
		const key = clientKey(item);
		for (const positions of [byId.get(item.id), key === undefined ? undefined : byClientId.get(key)])
			positions?.forEach(position => { index = Math.min(index, position); });
		if (index === Infinity) {
			indexItem(item, result.length);
			result.push(item);
		}
		else {
			const old = result[index];
			const merged = { ...old, ...item, clientMsgId: clientId || old.clientMsgId };
			if (old.recalled) Object.assign(merged, { recalled: true, content: old.content, type: 'text', file_name: null, fileName: undefined, file_size: null });
			if (old.status === 'sent' || item.status === 'sent') {
				merged.status = 'sent';
				merged.failureReason = undefined;
			}
			indexItem(old, index, true);
			result[index] = merged;
			indexItem(merged, index);
		}
	}
	return result.sort((a, b) => {
		if (a.room_seq && b.room_seq) return a.room_seq - b.room_seq;
		if (a.room_seq) return -1;
		if (b.room_seq) return 1;
		return 0;
	});
};
