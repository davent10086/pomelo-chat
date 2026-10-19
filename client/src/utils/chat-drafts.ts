/** Drafts stay in this tab, scoped by account and conversation. */
export interface ChatDraft {
	text: string;
	start: number;
	end: number;
}
const prefix = 'pomelo-chat.draft.v1.';
const fallback = new Map<string, ChatDraft>();
const draftStorage = () => window.pomeloDesktop ? localStorage : sessionStorage;
export const draftKey = (userId: number, room: string) =>
	`${prefix}${userId}.${encodeURIComponent(room)}`;
export function readDraft(key: string): ChatDraft {
	if (fallback.has(key)) return fallback.get(key)!;
	try {
		const raw = draftStorage().getItem(key);
		if (raw) {
			const value = JSON.parse(raw);
			if (typeof value.text === 'string') {
				const position = (n: unknown) =>
					typeof n === 'number' && Number.isFinite(n)
						? Math.max(0, Math.min(value.text.length, n))
						: value.text.length;
				return { text: value.text, start: position(value.start), end: position(value.end) };
			}
		}
	} catch {
		/* In-memory drafts still survive conversation switches. */
	}
	return fallback.get(key) || { text: '', start: 0, end: 0 };
}
export function writeDraft(key: string, draft: ChatDraft) {
	fallback.set(key, draft);
	try {
		if (draft.text) draftStorage().setItem(key, JSON.stringify(draft));
		else draftStorage().removeItem(key);
	} catch {
		/* Storage can be unavailable or full. */
	}
}
export function clearUserDrafts(userId: number) {
	const userPrefix = `${prefix}${userId}.`;
	for (const key of fallback.keys()) if (key.startsWith(userPrefix)) fallback.delete(key);
	try {
		for (const key of Object.keys(draftStorage()))
			if (key.startsWith(userPrefix)) draftStorage().removeItem(key);
	} catch {
		/* Best-effort cleanup when browser storage is unavailable. */
	}
}
