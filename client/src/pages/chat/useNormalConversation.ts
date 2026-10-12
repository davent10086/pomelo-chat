import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChatSocket } from './useChatSocket';
import { useHistoryView } from './useHistoryView';
import { useReadReceipt } from './useReadReceipt';
import { mergeMessages } from '@/utils/message-merge';

/** All ordinary-chat state stays behind session operations. */
export function useNormalConversation(
	room: string | undefined,
	type: 'private' | 'group',
	userId: number,
	onError: (message: string) => void,
	sourceId?: number
) {
	const session = useChatSocket({ onError });
	const history = useHistoryView(room, type, onError);
	const [searchOpen, setSearchOpen] = useState(false);
	const [atBottom, setAtBottom] = useState(false);
	const { openConversation, leaveConversation } = session;
	useEffect(() => {
		setSearchOpen(false);
		setAtBottom(false);
		if (room) openConversation({ room, type, sender_id: String(userId) });
		return leaveConversation;
	}, [room, type, userId, openConversation, leaveConversation]);
	useEffect(() => {
		if (room && sourceId) void history.locate(sourceId);
	}, [room, sourceId, history.locate]);
	const messages = useMemo(
		() =>
			mergeMessages(session.historyMsg, session.newMessage).filter(
				message => message.room === room
			),
		[session.historyMsg, session.newMessage, room]
	);
	const view = history.view?.messages.every(message => message.room === room)
		? history.view
		: undefined;
	const sequence = messages.reduce((max, message) => Math.max(max, message.room_seq || 0), 0);
	useReadReceipt(
		room,
		type,
		sequence,
		session.synchronized && atBottom && !searchOpen && !view && !history.loading
	);
	const leave = useCallback(() => {
		leaveConversation();
		history.reset();
		setSearchOpen(false);
		setAtBottom(false);
	}, [leaveConversation, history.reset]);
	return {
		messages,
		historyMsg: view?.messages || session.historyMsg.filter(message => message.room === room),
		newMessage: view ? [] : session.newMessage.filter(message => message.room === room),
		locating: !!view,
		focusId: view?.focusId,
		hasAfter: !!view?.hasAfter,
		hasMoreHistory: view ? view.hasBefore : session.hasMoreHistory,
		loading: history.loading || session.historyLoading,
		searchOpen,
		toggleSearch: () => setSearchOpen(value => !value),
		closeSearch: () => setSearchOpen(false),
		onAtBottom: setAtBottom,
		locate: history.locate,
		returnToLatest: history.reset,
		loadOlder: view ? () => history.load('before') : session.loadOlder,
		loadNewer: () => history.load('after'),
		leave,
		send: session.send,
		retry: session.retry,
		cancel: session.cancel
	};
}
