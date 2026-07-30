import { useCallback, useRef, useState } from 'react';

import type { IConnectParams } from './type';
import type { IMessageItem } from '@/components/MessageShow/type';

import { wsBaseURL } from '@/config';
import { safeParse } from '@/utils/safe-parse';
import { tokenStorage } from '@/utils/storage';
import ReconnectingWebSocket from '@/utils/websocket';
import type { ISendMessage } from '@/components/ChatTool/type';

interface UseChatSocketOptions {
	onError: (message: string) => void;
}

/** Owns socket lifecycle and received-message state for a non-AI chat session. */
export const useChatSocket = ({ onError }: UseChatSocketOptions) => {
	const socket = useRef<ReconnectingWebSocket | null>(null);
	const [historyMsg, setHistoryMsg] = useState<IMessageItem[]>([]);
	const [newMessage, setNewMessage] = useState<IMessageItem[]>([]);
	const [historyCursor, setHistoryCursor] = useState<number | undefined>();
	const [hasMoreHistory, setHasMoreHistory] = useState(false);

	const closeSocket = useCallback(() => {
		socket.current?.close();
		socket.current = null;
	}, []);

	const resetMessages = useCallback(() => {
		setHistoryMsg([]);
		setNewMessage([]);
		setHistoryCursor(undefined);
		setHasMoreHistory(false);
	}, []);

	const connect = useCallback((connectParams: IConnectParams) => {
		closeSocket();
		const token = tokenStorage.getItem();
		const ws = new ReconnectingWebSocket(
			`${wsBaseURL}/message/connect_chat?room=${connectParams.room}&id=${connectParams.sender_id}&type=${connectParams.type}`,
			undefined,
			token ? ['pomelo-token', token] : undefined
		);
		ws.onMessage = event => {
			const message = safeParse<
				IMessageItem | IMessageItem[] | { name?: string; messages?: IMessageItem[]; hasMore?: boolean; nextBeforeId?: number; client_msg_id?: string; id?: number; room_seq?: number }
			>(event.data, []);
			if (Array.isArray(message)) {
				setHistoryMsg(message.map(item => ({ ...item, status: 'sent' })));
				return;
			}
			if (message && typeof message === 'object' && 'name' in message) {
				if (message.name === 'history') {
					setHistoryMsg((message.messages || []).map(item => ({ ...item, status: 'sent' })));
					setHistoryCursor(message.nextBeforeId);
					setHasMoreHistory(Boolean(message.hasMore));
					return;
				}
				if (message.name === 'ack' && message.client_msg_id) {
					setNewMessage(previous =>
						previous.map(item =>
							item.clientMsgId === message.client_msg_id
								? { ...item, id: message.id, client_msg_id: message.client_msg_id, room_seq: message.room_seq, status: 'sent' }
								: item
						)
					);
					return;
				}
				if (message.name === 'error') {
					onError('消息发送失败，请稍后重试');
					return;
				}
			}
			setNewMessage(previous => {
				const incoming = message as IMessageItem;
				if (incoming.client_msg_id && previous.some(item => item.clientMsgId === incoming.client_msg_id)) {
					return previous.map(item =>
						item.clientMsgId === incoming.client_msg_id ? { ...incoming, status: 'sent' } : item
					);
				}
				return [...previous, { ...incoming, status: 'sent' }];
			});
		};
		ws.onError = () => onError('消息连接失败，正在重连…');
		ws.onMaxRetriesReached = () => onError('消息连接失败，请刷新页面重试');
		ws.connect();
		socket.current = ws;
	}, [closeSocket, onError]);

	const send = useCallback((message: ISendMessage) => {
		const clientMsgId = message.clientMsgId || `cm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
		if (!socket.current || socket.current.readyState !== WebSocket.OPEN) {
			return { clientMsgId, ok: false };
		}
		socket.current.send(JSON.stringify({ ...message, clientMsgId }));
		return { clientMsgId, ok: true };
	}, []);

	return {
		historyMsg,
		newMessage,
		setHistoryMsg,
		setNewMessage,
		historyCursor,
		hasMoreHistory,
		setHistoryCursor,
		setHasMoreHistory,
		resetMessages,
		connect,
		send,
		closeSocket
	};
};
