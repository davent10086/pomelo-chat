import type { ISendMessage } from '@/components/ChatTool/type';

export interface PendingMessage {
	key: string;
	userId: number;
	room: string;
	chatType: 'private' | 'group';
	message: ISendMessage & { clientMsgId: string };
	createdAt: number;
	owner?: string;
	leaseUntil?: number;
	stopped?: string;
}
let database: Promise<IDBDatabase> | undefined;
const open = () => {
	if (!database)
		database = new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('pomelo-pending-messages', 1);
			request.onupgradeneeded = () =>
				request.result.createObjectStore('messages', { keyPath: 'key' });
			request.onsuccess = () => {
				request.result.onversionchange = () => {
					request.result.close();
					database = undefined;
				};
				resolve(request.result);
			};
			request.onerror = () => {
				database = undefined;
				reject(request.error);
			};
			request.onblocked = () => {
				database = undefined;
				reject(new Error('本地消息存储被阻塞'));
			};
		});
	return database;
};
const transaction = async <T>(
	run: (store: IDBObjectStore, done: (value: T) => void) => void
): Promise<T> => {
	const db = await open();
	return new Promise((resolve, reject) => {
		const tx = db.transaction('messages', 'readwrite');
		let value: T;
		tx.oncomplete = () => resolve(value);
		tx.onerror = () => reject(tx.error || new Error('本地消息存储失败'));
		tx.onabort = () => reject(tx.error || new Error('本地消息事务中止'));
		try {
			run(tx.objectStore('messages'), result => {
				value = result;
			});
		} catch (error) {
			tx.abort();
			reject(error);
		}
	});
};
export const pendingKey = (userId: number, room: string, id: string) =>
	JSON.stringify([userId, room, id]);
export const listPendingMessages = (userId: number, room?: string) =>
	transaction<PendingMessage[]>((store, done) => {
		const request = store.getAll();
		request.onsuccess = () => {
			const rows = request.result as PendingMessage[];
			const now = Date.now();
			for (const row of rows)
				if (row.userId === userId && now - row.createdAt > 7 * 86400000) store.delete(row.key);
			done(
				rows.filter(
					row =>
						row.userId === userId &&
						(!room || row.room === room) &&
						now - row.createdAt <= 7 * 86400000
				)
			);
		};
	});
export const savePendingMessage = (row: PendingMessage) =>
	transaction<boolean>((store, done) => {
		const request = store.getAll();
		request.onsuccess = () => {
			const rows = request.result as PendingMessage[];
			const mine = rows.filter(
				item => item.userId === row.userId && Date.now() - item.createdAt <= 7 * 86400000
			);
			for (const item of rows)
				if (item.userId === row.userId && Date.now() - item.createdAt > 7 * 86400000)
					store.delete(item.key);
			if (mine.some(item => item.key === row.key)) {
				done(true);
				return;
			}
			if (mine.length >= 100) {
				done(false);
				return;
			}
			store.put(row);
			done(true);
		};
	});
export const claimPendingMessage = (key: string, owner: string, manual = false) =>
	transaction<PendingMessage | undefined>((store, done) => {
		const request = store.get(key);
		request.onsuccess = () => {
			const row = request.result as PendingMessage | undefined;
			if (
				!row ||
				(row.leaseUntil && row.leaseUntil > Date.now()) ||
				(!manual && (row.stopped || Date.now() - row.createdAt > 86400000))
			) {
				done(undefined);
				return;
			}
			const claimed = { ...row, owner, leaseUntil: Date.now() + 45000, stopped: undefined };
			store.put(claimed);
			done(claimed);
		};
	});
export const releasePendingMessage = (key: string, owner: string, stopped?: string) =>
	transaction<void>((store, done) => {
		const request = store.get(key);
		request.onsuccess = () => {
			const row = request.result as PendingMessage | undefined;
			if (row && (row.owner === owner || stopped))
				store.put({ ...row, owner: undefined, leaseUntil: 0, stopped });
			done(undefined);
		};
	});
export const removePendingMessage = (key: string) =>
	transaction<void>((store, done) => {
		store.delete(key);
		done(undefined);
	});
export const clearPendingMessages = (userId: number) =>
	transaction<void>((store, done) => {
		const request = store.getAll();
		request.onsuccess = () => {
			for (const row of request.result as PendingMessage[])
				if (row.userId === userId) store.delete(row.key);
			done(undefined);
		};
	});
