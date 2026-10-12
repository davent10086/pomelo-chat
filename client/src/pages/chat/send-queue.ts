import type { ISendMessage } from '@/components/ChatTool/type';
import type { IMessageItem } from '@/components/MessageShow/type';
import request from '@/utils/request';
import {
	pendingKey,
	listPendingMessages,
	savePendingMessage,
	claimPendingMessage,
	releasePendingMessage,
	removePendingMessage,
	type PendingMessage
} from '@/utils/pending-messages';
import { tokenStorage, userStorage } from '@/utils/storage';

interface QueueOptions {
	userId: number;
	room: string;
	chatType: 'private' | 'group';
	send: (message: ISendMessage) => boolean;
	onMessages: (messages: IMessageItem[]) => void;
	onState: (id: string, status: 'pending' | 'failed', reason?: string) => void;
	onError: (message: string) => void;
}
export class SendQueue {
	private owner = crypto.randomUUID();
	private stopped = false;
	private busy = false;
	private manualRequest?: string;
	private attempts = new Map<string, number>();
	private fallback = new Map<string, PendingMessage>();
	private cancelled = new Set<string>();
	private acknowledged = new Set<string>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private poll: ReturnType<typeof setInterval>;
	private controller = new AbortController();
	constructor(private options: QueueOptions) {
		this.poll = setInterval(() => void this.recover(), 5000);
	}
	private active() {
		return !this.stopped && Number(userStorage.getItem().id) === this.options.userId;
	}
	private item(row: PendingMessage): IMessageItem {
		return {
			...row.message,
			content: String(row.message.content),
			room: row.room,
			file_size: null,
			created_at: new Date(row.createdAt),
			status: 'failed',
			failureReason:
				row.stopped ||
				(Date.now() - row.createdAt > 86400000
					? '消息超过 24 小时，请手动重试'
					: (this.attempts.get(row.message.clientMsgId) || 0) >= 3
						? '自动重试已结束，请手动重试'
						: '等待恢复发送')
		};
	}
	async enqueue(message: ISendMessage) {
		const id = message.clientMsgId || `cm_${crypto.randomUUID()}`;
		const row: PendingMessage = {
			key: pendingKey(this.options.userId, this.options.room, id),
			userId: this.options.userId,
			room: this.options.room,
			chatType: this.options.chatType,
			message: { ...message, clientMsgId: id },
			createdAt: Date.now()
		};
		try {
			if (!(await savePendingMessage(row)))
				throw new Error('待发送消息已达 100 条，请先重试或取消现有消息');
		} catch (error) {
			if (error instanceof Error && error.message.includes('100')) throw error;
			this.options.onError('无法保存待发送消息，本次消息仅能在当前页面恢复');
			this.fallback.set(id, row);
		}
		if (!tokenStorage.getItem() || Number(userStorage.getItem().id) !== this.options.userId) {
			await removePendingMessage(row.key).catch(() => undefined);
			return { clientMsgId: id, ok: false };
		}
		if (!this.active()) return { clientMsgId: id, ok: false };
		this.options.onMessages([this.item(row)]);
		await this.transmit(row, true);
		return { clientMsgId: id, ok: true };
	}
	async acknowledge(messages: Array<Pick<IMessageItem, 'client_msg_id' | 'sender_id'>>) {
		for (const message of messages) {
			const id = message.client_msg_id;
			if (!id || Number(message.sender_id) !== this.options.userId) continue;
			this.acknowledged.add(id);
			clearTimeout(this.timers.get(id));
			this.timers.delete(id);
			this.fallback.delete(id);
			try {
				await removePendingMessage(pendingKey(this.options.userId, this.options.room, id));
			} catch {
				/* in-page fallback */
			}
		}
	}
	async recover(manualId?: string) {
		if (!this.active()) return;
		if (manualId) {
			clearTimeout(this.timers.get(manualId));
			this.timers.delete(manualId);
			await releasePendingMessage(
				pendingKey(this.options.userId, this.options.room, manualId),
				this.owner
			).catch(() => undefined);
		}
		if (this.busy) {
			if (manualId) this.manualRequest = manualId;
			return;
		}
		this.busy = true;
		try {
			let rows: PendingMessage[];
			try {
				rows = await listPendingMessages(this.options.userId, this.options.room);
			} catch {
				rows = [];
			}
			rows = [...new Map([...rows, ...this.fallback.values()].map(row => [row.key, row])).values()];
			rows = rows.filter(
				row =>
					!this.cancelled.has(row.message.clientMsgId) &&
					!this.acknowledged.has(row.message.clientMsgId) &&
					row.chatType === this.options.chatType
			);
			if (!rows.length || !this.active()) return;
			this.options.onMessages(
				rows.filter(row => !this.timers.has(row.message.clientMsgId)).map(row => this.item(row))
			);
			const response = await request.post(
				'/message/resolve',
				{
					room: this.options.room,
					type: this.options.chatType,
					clientMsgIds: rows.map(row => row.message.clientMsgId)
				},
				{ signal: this.controller.signal }
			);
			if (!this.active()) return;
			if (response.data.code !== 200) throw { code: response.data.code };
			const saved = (response.data.data as { messages: IMessageItem[] }).messages;
			this.options.onMessages(
				saved.map(message => ({ ...message, status: 'sent', failureReason: undefined }))
			);
			await this.acknowledge(saved);
			for (const row of rows) {
				const id = row.message.clientMsgId;
				if (this.cancelled.has(id) || this.acknowledged.has(id) || this.timers.has(id)) continue;
				const manual = id === manualId;
				if (manual) this.attempts.delete(id);
				if (
					manual ||
					(!row.stopped &&
						Date.now() - row.createdAt <= 86400000 &&
						(this.attempts.get(id) || 0) < 3)
				)
					await this.transmit(row, manual);
			}
		} catch (error) {
			const code = (error as { code?: number; status?: number }).code;
			if (
				this.active() &&
				(code === 1007 ||
					code === 1002 ||
					code === 1006 ||
					(error as { status?: number }).status === 403 ||
					(error as { status?: number }).status === 401)
			) {
				await this.rejectAll('会话权限已失效，请停止重试');
			}
		} finally {
			this.busy = false;
			const requested = this.manualRequest;
			this.manualRequest = undefined;
			if (requested && this.active()) void this.recover(requested);
		}
	}
	private async transmit(row: PendingMessage, manual: boolean) {
		const id = row.message.clientMsgId;
		if (
			!this.active() ||
			this.cancelled.has(id) ||
			this.acknowledged.has(id) ||
			this.timers.has(id)
		)
			return;
		let claimed: PendingMessage | undefined;
		try {
			claimed = this.fallback.get(id) || (await claimPendingMessage(row.key, this.owner, manual));
		} catch {
			claimed = this.fallback.get(id);
		}
		if (!claimed) return;
		if (!this.active() || this.cancelled.has(id) || this.acknowledged.has(id)) {
			await releasePendingMessage(row.key, this.owner).catch(() => undefined);
			return;
		}
		if (!this.options.send(row.message)) {
			await releasePendingMessage(row.key, this.owner).catch(() => undefined);
			this.options.onState(id, 'failed', '连接未就绪，恢复连接后将自动核对发送');
			return;
		}
		const attempt = manual ? 0 : (this.attempts.get(id) || 0) + 1;
		this.attempts.set(id, attempt);
		this.options.onState(id, 'pending');
		this.timers.set(
			id,
			setTimeout(() => {
				if (!this.active() || this.acknowledged.has(id)) return;
				this.options.onState(
					id,
					'failed',
					attempt >= 3 ? '自动重试已结束，请手动重试' : '确认超时，正在核对发送结果'
				);
				const delay = [1000, 3000, 10000][Math.min(attempt, 2)];
				this.timers.set(
					id,
					setTimeout(() => {
						this.timers.delete(id);
						void releasePendingMessage(row.key, this.owner)
							.catch(() => undefined)
							.then(() => this.recover());
					}, delay)
				);
			}, 15000)
		);
	}
	async reject(id: string, reason: string) {
		if (this.acknowledged.has(id)) return;
		clearTimeout(this.timers.get(id));
		this.timers.delete(id);
		this.attempts.set(id, 3);
		await releasePendingMessage(
			pendingKey(this.options.userId, this.options.room, id),
			this.owner,
			reason
		).catch(() => undefined);
		const fallback = this.fallback.get(id);
		if (fallback) fallback.stopped = reason;
		if (this.active() && !this.acknowledged.has(id)) this.options.onState(id, 'failed', reason);
	}
	private async rejectAll(reason: string) {
		const rows = await listPendingMessages(this.options.userId, this.options.room).catch(() => [
			...this.fallback.values()
		]);
		for (const row of rows) {
			await this.reject(row.message.clientMsgId, reason);
		}
	}
	async cancel(id: string) {
		this.cancelled.add(id);
		clearTimeout(this.timers.get(id));
		this.timers.delete(id);
		this.attempts.set(id, 3);
		this.fallback.delete(id);
		await removePendingMessage(pendingKey(this.options.userId, this.options.room, id)).catch(
			() => undefined
		);
		this.options.onState(id, 'failed', '已取消重试；已提交的消息不会被撤回');
	}
	disconnected() {
		this.attempts.clear();
		for (const [id, timer] of this.timers) {
			clearTimeout(timer);
			void releasePendingMessage(
				pendingKey(this.options.userId, this.options.room, id),
				this.owner
			).catch(() => undefined);
		}
		this.timers.clear();
	}
	stop() {
		this.disconnected();
		this.stopped = true;
		this.controller.abort();
		clearInterval(this.poll);
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}
}
