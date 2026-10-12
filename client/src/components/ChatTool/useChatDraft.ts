import {
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
	type RefObject,
	type SetStateAction
} from 'react';
import { draftKey, readDraft, writeDraft } from '@/utils/chat-drafts';

/** The composer is keyed by room. Persist edits synchronously before it can unmount. */
export function useChatDraft(userId: number, room: string, input: RefObject<HTMLTextAreaElement>) {
	const key = draftKey(userId, room);
	const [initial] = useState(() => readDraft(key));
	const [text, setText] = useState(initial.text);
	const current = useRef(initial);
	const mounted = useRef(true);
	const setValue = useCallback(
		(value: SetStateAction<string>) => {
			const next = typeof value === 'function' ? value(current.current.text) : value;
			const start = Math.min(current.current.start, next.length);
			const end = Math.min(current.current.end, next.length);
			current.current = { text: next, start, end };
			writeDraft(key, current.current);
			setText(next);
		},
		[key]
	);
	const saveSelection = useCallback(() => {
		const el = input.current;
		if (!el) return;
		current.current = { ...current.current, start: el.selectionStart, end: el.selectionEnd };
		writeDraft(key, current.current);
	}, [key, input]);
	useLayoutEffect(() => {
		mounted.current = true;
		input.current?.setSelectionRange(initial.start, initial.end);
		return () => {
			mounted.current = false;
		};
	}, [initial, input]);
	const clearSent = useCallback(
		(sentText: string) => {
			// A completed send must not erase text typed while awaiting the response.
			if (readDraft(key).text !== sentText) return;
			writeDraft(key, { text: '', start: 0, end: 0 });
			if (mounted.current && current.current.text === sentText) {
				current.current = { text: '', start: 0, end: 0 };
				setText('');
			}
		},
		[key]
	);
	return { text, setValue, saveSelection, clearSent };
}
