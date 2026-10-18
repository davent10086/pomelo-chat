import { useCallback, useEffect, useRef, useState } from 'react';

import type { IConnectParams } from './type';
import type { IMessageItem } from '@/components/MessageShow/type';

import { wsBaseURL } from '@/config';
import { safeParse } from '@/utils/safe-parse';
import { tokenStorage } from '@/utils/storage';
import ReconnectingWebSocket from '@/utils/websocket';
import request from '@/utils/request';
import { mergeMessages } from '@/utils/message-merge';
import { SendQueue } from './send-queue';
import type { ISendMessage } from '@/components/ChatTool/type';

interface UseChatSocketOptions {
	onError: (message: string) => void;
}

/** Owns socket lifecycle and received-message state for a non-AI chat session. */
export const useChatSocket = ({ onError }: UseChatSocketOptions) => {
	const currentParams = useRef<IConnectParams>();
	const generation = useRef(0);
	const lastSequence = useRef(0);
	const queue = useRef<SendQueue>();
	const syncController = useRef<AbortController>();
	const [synchronized, setSynchronized] = useState(false);
	const historyRequest = useRef<AbortController>();
	const historyBusy = useRef(false);
	const [historyLoading, setHistoryLoading] = useState(false);
	const socket = useRef<ReconnectingWebSocket | null>(null);
	const [historyMsg, setHistoryMsg] = useState<IMessageItem[]>([]);
	const [newMessage, setNewMessage] = useState<IMessageItem[]>([]);
	const [peerRead, setPeerRead] = useState({ room: '', sequence: 0 });
	const [historyCursor, setHistoryCursor] = useState<number | undefined>();
	const [hasMoreHistory, setHasMoreHistory] = useState(false);

	const closeSocket = useCallback(() => {
		generation.current++;
		syncController.current?.abort();
		queue.current?.stop();
		queue.current = undefined;
		setSynchronized(false);
		historyRequest.current?.abort();
		historyBusy.current = false;
		setHistoryLoading(false);
		socket.current?.destroy();
		socket.current = null;
	}, []);

	const resetMessages = useCallback(() => {
		lastSequence.current = 0;
		setPeerRead({ room: '', sequence: 0 });
		setHistoryMsg([]);
		setNewMessage([]);
		setHistoryCursor(undefined);
		setHasMoreHistory(false);
	}, []);

	const connect = useCallback(
		(connectParams: IConnectParams) => {
			closeSocket();
			currentParams.current = connectParams;
			const epoch = generation.current;
			const receiveReadCursor = (sequence: number | undefined) => {
				if (
					epoch !== generation.current ||
					connectParams.type !== 'private' ||
					!Number.isSafeInteger(sequence) ||
					Number(sequence) < 0
				)
					return;
				setPeerRead(previous => ({
					room: connectParams.room,
					sequence: Math.max(
						previous.room === connectParams.room ? previous.sequence : 0,
						Number(sequence)
					)
				}));
			};
			const controller = new AbortController();
			syncController.current = controller;
			const token = tokenStorage.getItem();
			const ws = new ReconnectingWebSocket(
				`${wsBaseURL}/message/connect_chat?room=${encodeURIComponent(connectParams.room)}&id=${connectParams.sender_id}&type=${connectParams.type}`,
				undefined,
				token ? ['pomelo-token', token] : undefined
			);
			queue.current = new SendQueue({
				userId: Number(connectParams.sender_id),
				room: connectParams.room,
				chatType: connectParams.type,
				send: message => {
					if (epoch !== generation.current || ws.readyState !== WebSocket.OPEN) return false;
					ws.send(JSON.stringify(message));
					return true;
				},
				onMessages: incoming => {
					if (epoch === generation.current)
						setNewMessage(previous => mergeMessages(previous, incoming));
				},
				onState: (id, status, failureReason) => {
					if (epoch === generation.current)
						setNewMessage(previous =>
							previous.map(item =>
								(item.clientMsgId || item.client_msg_id) === id && item.status !== 'sent'
									? { ...item, status, failureReason }
									: item
							)
						);
				},
				onError
			});
			let syncing = false;
			let recoveryCursor: number | undefined;
			const catchUp = async (since: number) => {
				if (since < 1 || epoch !== generation.current) return;
				recoveryCursor = Math.min(recoveryCursor ?? since, since);
				if (syncing) return;
				syncing = true;
				setSynchronized(false);
				try {
					while (recoveryCursor !== undefined && epoch === generation.current) {
						const start: number = recoveryCursor;
						let cursor = start;
						while (epoch === generation.current) {
							const res = await request.get<{ messages: IMessageItem[]; hasMore: boolean }>(
								'/message/history',
								{
									signal: controller.signal,
									params: {
										room: connectParams.room,
										type: connectParams.type,
										afterSeq: cursor,
										limit: 80
									}
								}
							);
							if (epoch !== generation.current) return;
							const missing = res.data.data.messages.map(m => ({ ...m, status: 'sent' as const }));
							setHistoryMsg(previous => mergeMessages(previous, missing));
							void queue.current?.acknowledge(missing);
							setNewMessage(previous =>
								previous.filter(
									item =>
										!missing.some(
											m =>
												(m.id && m.id === item.id) ||
												(m.client_msg_id && m.client_msg_id === item.clientMsgId)
										)
								)
							);
							lastSequence.current = Math.max(
								lastSequence.current,
								...missing.map(m => Number(m.room_seq || 0))
							);
							if (!missing.length || !res.data.data.hasMore) break;
							const next = Number(missing[missing.length - 1].room_seq);
							if (next <= cursor) throw new Error('History cursor did not advance');
							cursor = next;
						}
						if (recoveryCursor === start) recoveryCursor = undefined;
					}
				} catch {
					if (epoch === generation.current) onError('补齐消息失败，请重新连接');
				} finally {
					syncing = false;
					if (epoch === generation.current && recoveryCursor === undefined) setSynchronized(true);
				}
			};
			ws.onMessage = async event => {
				if (epoch !== generation.current) return;
				const message = safeParse<
					| IMessageItem
					| IMessageItem[]
					| {
							name?: string;
							messages?: IMessageItem[];
							hasMore?: boolean;
							nextBeforeId?: number;
							client_msg_id?: string;
							id?: number;
							room_seq?: number;
							room?: string;
							userId?: number | string;
							roomSeq?: number;
							peerReadSeq?: number;
							message?: string;
							code?: string;
							retryAfterMs?: number;
							retryable?: boolean;
					  }
				>(event.data, []);
				if (Array.isArray(message)) {
					setHistoryMsg(message.map(item => ({ ...item, status: 'sent' })));
					return;
				}
				if (message && typeof message === 'object' && 'name' in message) {
					if (message.name === 'read_receipt') {
						if (
							message.room === connectParams.room &&
							message.userId !== undefined &&
							String(message.userId) !== String(connectParams.sender_id)
						)
							receiveReadCursor(message.roomSeq);
						return;
					}
					if (message.name === 'history') {
						receiveReadCursor(message.peerReadSeq);
						const since = lastSequence.current;
						const batch = (message.messages || []).map(item => ({
							...item,
							status: 'sent' as const
						}));
						setHistoryMsg(previous => mergeMessages(previous, batch));
						setNewMessage(previous =>
							previous.filter(
								item =>
									!batch.some(
										m =>
											(m.id && m.id === item.id) ||
											(m.client_msg_id && m.client_msg_id === item.clientMsgId)
									)
							)
						);
						lastSequence.current = Math.max(
							lastSequence.current,
							...batch.map(m => Number(m.room_seq || 0))
						);
						await catchUp(since);
						if (epoch !== generation.current) return;
						if (!since) setSynchronized(true);
						void queue.current?.acknowledge(batch);
						void queue.current?.recover();
						if (epoch !== generation.current) return;
						setHistoryCursor(message.nextBeforeId);
						setHasMoreHistory(Boolean(message.hasMore));
						return;
					}
					if (message.name === 'resync') {
						if (connectParams.type === 'private') {
							try {
								const result = await request.get<{ peerReadSeq: number }>('/message/history', {
									params: { room: connectParams.room, type: connectParams.type, limit: 1 },
									signal: controller.signal
								});
								if (result.data.code === 200) receiveReadCursor(result.data.data.peerReadSeq);
							} catch {
								/* Reconnect history will restore the persisted cursor. */
							}
						}
						await catchUp(recoveryCursor ?? lastSequence.current);
						return;
					}
					if (message.name === 'ack' && message.client_msg_id) {
						void queue.current?.acknowledge([
							{ client_msg_id: message.client_msg_id, sender_id: Number(connectParams.sender_id) }
						]);
						setNewMessage(previous =>
							previous.map(item =>
								item.clientMsgId === message.client_msg_id
									? {
											...item,
											id: message.id,
											client_msg_id: message.client_msg_id,
											room_seq: message.room_seq,
											status: 'sent',
											failureReason: undefined
										}
									: item
							)
						);
						return;
					}
					if (message.name === 'error') {
						if (message.client_msg_id)
							void queue.current?.reject(
								message.client_msg_id,
								message.message || '消息发送失败，请核对后重试',
								message.code === 'MESSAGE_OVERLOADED' && message.retryable
									? message.retryAfterMs
									: undefined
							);
						onError('消息发送失败，请稍后重试');
						return;
					}
				}
				const incoming = message as IMessageItem;
				if (!incoming.content || incoming.room !== connectParams.room) return;
				// Receipt means parsed by this client, not rendered or read by its user.
				const receipt = (message as IMessageItem & { receipt?: string }).receipt;
				if (typeof receipt === 'string' && /^[a-f0-9]{32}$/.test(receipt))
					ws.send(JSON.stringify({ name: 'delivery_ack', receipt }));
				const previousSequence = lastSequence.current;
				if (previousSequence > 0 && Number(incoming.room_seq) > previousSequence + 1)
					void catchUp(previousSequence);
				lastSequence.current = Math.max(lastSequence.current, Number(incoming.room_seq || 0));
				void queue.current?.acknowledge([incoming]);
				setNewMessage(previous => mergeMessages(previous, [{ ...incoming, status: 'sent' }]));
			};
			ws.onClose = () => {
				if (epoch === generation.current) {
					setSynchronized(false);
					queue.current?.disconnected();
				}
			};
			ws.onError = () => {
				if (epoch === generation.current) onError('消息连接失败，正在重连…');
			};
			ws.onMaxRetriesReached = () => {
				if (epoch === generation.current) onError('消息连接失败，请刷新页面重试');
			};
			ws.connect();
			socket.current = ws;
		},
		[closeSocket, onError]
	);

	useEffect(() => {
		const handler = () => {
			if (currentParams.current && socket.current) connect(currentParams.current);
		};
		window.addEventListener('pomelo-token-changed', handler);
		window.addEventListener('pomelo-logout', closeSocket);
		return () => {
			window.removeEventListener('pomelo-token-changed', handler);
			window.removeEventListener('pomelo-logout', closeSocket);
		};
	}, [connect]);
	const send = useCallback(async (message: ISendMessage) => {
		if (!queue.current) throw new Error('消息连接尚未初始化');
		return queue.current.enqueue(message);
	}, []);
	const retry = useCallback((item: IMessageItem) => {
		const id = item.clientMsgId || item.client_msg_id;
		if (id) void queue.current?.recover(id);
	}, []);
	const cancel = useCallback((item: IMessageItem) => {
		const id = item.clientMsgId || item.client_msg_id;
		if (id) void queue.current?.cancel(id);
	}, []);
	useEffect(() => () => closeSocket(), [closeSocket]);

	const openConversation = useCallback(
		(params: IConnectParams) => {
			closeSocket();
			resetMessages();
			connect(params);
		},
		[closeSocket, resetMessages, connect]
	);
	const leaveConversation = useCallback(() => {
		currentParams.current = undefined;
		closeSocket();
		resetMessages();
	}, [closeSocket, resetMessages]);
	const loadOlder = useCallback(async () => {
		const params = currentParams.current;
		if (!params || !historyCursor || !hasMoreHistory || historyBusy.current) return;
		const epoch = generation.current;
		historyBusy.current = true;
		setHistoryLoading(true);
		const controller = new AbortController();
		historyRequest.current = controller;
		try {
			const response = await request.get<{
				messages: IMessageItem[];
				hasMore: boolean;
				nextBeforeId?: number;
			}>('/message/history', {
				params: { room: params.room, type: params.type, beforeId: historyCursor, limit: 30 },
				signal: controller.signal
			});
			if (epoch !== generation.current) return;
			if (response.data.code !== 200) throw new Error('History unavailable');
			setHistoryMsg(previous => mergeMessages(previous, response.data.data.messages));
			setHistoryCursor(response.data.data.nextBeforeId);
			setHasMoreHistory(response.data.data.hasMore);
		} catch {
			if (epoch === generation.current) onError('无法加载历史消息，请重试');
		} finally {
			if (epoch === generation.current) {
				historyBusy.current = false;
				setHistoryLoading(false);
			}
		}
	}, [historyCursor, hasMoreHistory, onError]);
	return {
		peerRead,
		retry,
		cancel,
		synchronized,
		historyMsg,
		newMessage,
		hasMoreHistory,
		historyLoading,
		loadOlder,
		openConversation,
		leaveConversation,
		send
	};
};
