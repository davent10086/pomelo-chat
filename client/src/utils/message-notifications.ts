import { apiBaseURL } from '@/config';
import { userStorage } from './storage';
import { readConversationPreferences } from './conversation-preferences';

export interface MessageNotice { id: number; room: string; senderId: number; createdAt: number }
let activeRoom: string | undefined;
const seen = new Set<number>();
const openNotifications = new Set<Notification>();
let account = '';
const settingsKey = () => `pomelo-chat.notifications.v1.${encodeURIComponent(apiBaseURL)}.${userStorage.getItem().id}`;
export const setActiveNotificationRoom = (room?: string) => { activeRoom = room; };
export const notificationsEnabled = () => {
	try { return localStorage.getItem(settingsKey()) === 'true'; } catch { return false; }
};
export async function toggleMessageNotifications(): Promise<boolean> {
	if (!('Notification' in window)) throw new Error('当前环境不支持系统通知');
	const enabled = !notificationsEnabled();
	if (enabled && await Notification.requestPermission() !== 'granted') throw new Error('请在系统或浏览器设置中允许通知');
	localStorage.setItem(settingsKey(), String(enabled));
	if (!enabled) for (const notice of openNotifications) notice.close();
	return enabled;
}
export function showMessageNotification(notice: MessageNotice) {
	const user = userStorage.getItem();
	const currentAccount = `${apiBaseURL}:${user.id}`;
	if (currentAccount !== account) { seen.clear(); account = currentAccount; }
	if (!Number.isSafeInteger(notice.id) || !notice.room || !user.id || notice.senderId === user.id || seen.has(notice.id)) return;
	seen.add(notice.id);
	if (seen.size > 512) seen.delete(seen.values().next().value!);
	if (!notificationsEnabled() || !('Notification' in window) || Notification.permission !== 'granted' ||
		readConversationPreferences(notice.room).muted ||
		(document.hasFocus() && document.visibilityState === 'visible' && activeRoom === notice.room) ||
		Date.now() - notice.createdAt > 60000) return;
	try {
		const notification = new Notification('Pomelo Chat · 新消息', { body: '你收到了一条新消息，点击查看', tag: `pomelo:${user.id}:${notice.room}` });
		openNotifications.add(notification);
		notification.onclose = () => openNotifications.delete(notification);
		notification.onclick = () => {
			notification.close();
			if (userStorage.getItem().id !== user.id) return;
			window.focus();
			if (window.pomeloDesktop) void window.pomeloDesktop.focusMain().catch(() => undefined);
			window.dispatchEvent(new CustomEvent('pomelo-open-conversation', { detail: notice.room }));
		};
	} catch { /* Notifications must never interrupt message delivery. */ }
}
window.addEventListener('pomelo-logout', () => {
	for (const notification of openNotifications) notification.close();
	openNotifications.clear(); seen.clear(); activeRoom = undefined;
});
