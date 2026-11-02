import { apiBaseURL } from '@/config';
import { userStorage } from './storage';

export interface ConversationPreferences { pinned?: boolean; muted?: boolean; hiddenMessageIds?: number[] }
const event = 'pomelo-conversation-preferences';
const fallback = new Map<string, ConversationPreferences>();
const key = (room: string) => `pomelo-chat.conversation.v1.${encodeURIComponent(apiBaseURL)}.${userStorage.getItem().id}.${encodeURIComponent(room)}`;
export function readConversationPreferences(room: string): ConversationPreferences {
	const id = key(room);
	if (fallback.has(id)) return fallback.get(id)!;
	try {
		const raw = localStorage.getItem(id);
		const value = raw ? JSON.parse(raw) : fallback.get(id);
		return value && typeof value === 'object' ? value : {};
	} catch { return fallback.get(id) || {}; }
}
export function writeConversationPreferences(room: string, patch: Partial<ConversationPreferences>) {
	const id = key(room), value = { ...readConversationPreferences(room), ...patch };
	fallback.set(id, value);
	try { localStorage.setItem(id, JSON.stringify(value)); } catch { /* Keep preferences for this session. */ }
	window.dispatchEvent(new Event(event));
}
export function subscribeConversationPreferences(listener: () => void) {
	const onStorage = (change: StorageEvent) => {
		if (change.key) fallback.delete(change.key); else fallback.clear();
		listener();
	};
	window.addEventListener(event, listener);
	window.addEventListener('storage', onStorage);
	return () => { window.removeEventListener(event, listener); window.removeEventListener('storage', onStorage); };
}
