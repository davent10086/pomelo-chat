import { clearSessionStorage, tokenStorage, userStorage, type IUserInfo } from '@/utils/storage';

export interface DesktopAuth { token: string; user: IUserInfo }
export interface DesktopChat { room: string; type: 'private' | 'group'; receiverId: number; name: string }
export interface DesktopSnapshot { revision: number; auth: DesktopAuth | null; chat: DesktopChat | null }
export interface AssistantBounds { origin: string; width: number; height: number; x: number; y: number }
export interface DesktopBridge {
	windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<boolean>;
	getSnapshot(): Promise<DesktopSnapshot>;
	publishAuth(auth: DesktopAuth | null): Promise<void>;
	invalidateAuth(token: string): Promise<void>;
	publishChat(chat: DesktopChat | null): Promise<void>;
	resizeAssistant(expanded: boolean, ticket: number, token: string): Promise<AssistantBounds>;
	dragAssistant(dx: number, dy: number): void;
	subscribe(callback: (snapshot: DesktopSnapshot) => void): () => void;
}
declare global { interface Window { pomeloDesktop?: DesktopBridge } }

export const isDesktopAssistant = () => window.location.pathname === '/desktop-assistant';

/** Only the main renderer publishes credentials; microtasks combine token + user writes. */
export function initializeDesktopSync() {
	const bridge = window.pomeloDesktop;
	if (!bridge || isDesktopAssistant()) return;
	document.documentElement.classList.add('desktop-main-surface');
	let queued = false;
	let synchronizedToken = '';
	const publish = () => {
		if (queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			const token = tokenStorage.getItem(), user = userStorage.getItem();
			void bridge.publishAuth(token && user.id > 0 ? {
				token,
				user: { id: user.id, username: String(user.username || ''), name: String(user.name || ''), avatar: String(user.avatar || ''),
					phone: user.phone || '', signature: user.signature || '', created_at: String(user.created_at || '') }
			} : null).catch(() => console.error('Desktop login synchronization failed'));
		});
	};
	window.addEventListener('pomelo-session-changed', publish);
	bridge.subscribe(snapshot => {
		if (snapshot.auth) synchronizedToken = snapshot.auth.token;
		if (!snapshot.auth && synchronizedToken && tokenStorage.getItem() === synchronizedToken) {
			synchronizedToken = '';
			clearSessionStorage();
			window.location.assign('/login');
		}
	});
	publish();
}

export function invalidateDesktopAuth(token: string) {
	if (window.pomeloDesktop) void window.pomeloDesktop.invalidateAuth(token).catch(() => undefined);
}
