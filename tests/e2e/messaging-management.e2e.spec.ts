import { test, expect } from '@playwright/test';
import { setup, login, connectFriends } from './helpers/chat';

test('browser conversation management works by touch and keyboard without entering the chat', async ({ page }, testInfo) => {
	const { api, a, b, room } = await setup();
	try {
		await page.setViewportSize({ width: 390, height: 844 });
		await login(page, a);
		const actions = page.getByRole('button', { name: `管理会话 ${b.username}`, exact: true });
		await actions.click();
		await page.getByRole('menuitem', { name: '置顶会话', exact: true }).click();
		await expect(page.locator(`[id="chatList_${room}"]`).getByLabel('已置顶')).toBeVisible();
		await expect(page.getByLabel('消息输入框')).toHaveCount(0);
		await actions.focus(); await actions.press('Enter');
		await page.getByRole('menuitem', { name: '消息免打扰', exact: true }).click();
		await expect(page.locator(`[id="chatList_${room}"]`).getByLabel('免打扰')).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.screenshot({ path: testInfo.outputPath('browser-conversation-management.png') });
	} finally { await api.dispose(); }
});

test('real message notices respect mute, deduplicate retries and open the intended conversation', async ({ page, browser }) => {
	test.setTimeout(60000);
	const { api, a, b, room } = await setup();
	const peerContext = await browser.newContext();
	try {
		await peerContext.addInitScript(() => {
			const notices: { title: string; options: NotificationOptions; onclick?: () => void }[] = [];
			Object.defineProperty(window, '__notices', { value: notices });
			class TestNotification {
				static permission = 'granted';
				static requestPermission = async () => 'granted';
				onclick?: () => void;
				onclose?: () => void;
				constructor(public title: string, public options: NotificationOptions) { notices.push(this); }
				close() { this.onclose?.(); }
			}
			Object.defineProperty(window, 'Notification', { value: TestNotification, configurable: true });
		});
		const peer = await peerContext.newPage();
		await login(peer, b);
		await peer.evaluate(async () => { const path = '/src/utils/message-notifications.ts'; await (await import(path)).toggleMessageNotifications(); });
		await login(page, a, room);
		const input = page.getByLabel('消息输入框');
		await input.fill('需要系统提醒的消息'); await input.press('Enter');
		await expect.poll(() => peer.evaluate(() => (window as unknown as { __notices: unknown[] }).__notices.length)).toBe(1);
		await peer.evaluate(() => (window as unknown as { __notices: { onclick: () => void }[] }).__notices[0].onclick());
		await expect(peer.getByLabel('消息输入框')).toBeVisible();
		await expect(peer.locator('[data-message-index]').getByText('需要系统提醒的消息', { exact: true })).toBeVisible();
		const chat = peer.locator(`[id="chatList_${room}"]`);
		await chat.click({ button: 'right' }); await peer.getByRole('menuitem', { name: '消息免打扰', exact: true }).click();
		let received = false, ready = false;
		peer.on('websocket', socket => socket.on('framereceived', frame => {
			const data = JSON.parse(String(frame.payload)); if (data.name === 'chatList' && data.notice) received = true;
			if (data.name === 'notification_ready') ready = true;
		}));
		// Reload establishes an observed real notification channel and retains mute.
		await peer.reload();
		await expect.poll(() => ready).toBe(true);
		await input.fill('免打扰期间的消息'); await input.press('Enter');
		await expect.poll(() => received).toBe(true);
		await expect.poll(() => peer.evaluate(() => (window as unknown as { __notices: unknown[] }).__notices.length)).toBe(0);
		await peer.evaluate(async () => {
			const path = '/src/utils/conversation-preferences.ts';
			(await import(path)).writeConversationPreferences('synthetic-room', { muted: false });
			const noticesPath = '/src/utils/message-notifications.ts', notices = await import(noticesPath);
			const notice = { id: 987654321, room: 'synthetic-room', senderId: -1, createdAt: Date.now() };
			notices.showMessageNotification(notice); notices.showMessageNotification(notice);
		});
		await expect.poll(() => peer.evaluate(() => (window as unknown as { __notices: unknown[] }).__notices.length)).toBe(1);
	} finally { await peerContext.close(); await api.dispose(); }
});

test('quote, confirmed forwarding, persistent local hide, pin and mute use real backend', async ({ page }) => {
	test.setTimeout(60000);
	const { api, a, b, room, create } = await setup();
	try {
		const c = await create(3);
		const target = await connectFriends(api, a, c);
		await login(page, a, room);
		a.token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pomelo-chat.authToken')!));
		const input = page.getByLabel('消息输入框');
		await input.fill('待引用转发的原文'); await input.press('Enter');
		const message = page.locator('[data-message-index]').filter({ hasText: '待引用转发的原文' });
		await expect(message.getByRole('status', { name: '已发送', exact: true })).toBeVisible();
		await message.getByLabel('消息更多操作').click();
		await page.getByRole('menuitem', { name: '引用回复', exact: true }).click();
		await expect(input).toHaveValue(/待引用转发的原文/);
		await input.fill('');
		await message.getByLabel('消息更多操作').click();
		await page.getByRole('menuitem', { name: '转发到会话', exact: true }).click();
		await page.getByRole('combobox', { name: '转发接收会话' }).click();
		await page.getByText(`${c.username} (${c.username})`, { exact: true }).click();
		await page.getByRole('button', { name: '确认转发', exact: true }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		const forwarded = await api.get('message/history', { headers: { Authorization: `Bearer ${a.token}` }, params: { room: target, type: 'private' } });
		expect((await forwarded.json()).data.messages.filter((m: { content: string }) => m.content === '待引用转发的原文')).toHaveLength(1);
		const sourceId = Number(await message.getAttribute('data-message-id'));
		const outsider = await api.post('message/forward', { headers: { Authorization: `Bearer ${c.token}` }, data: { sourceId, room: target, type: 'private', clientMsgId: crypto.randomUUID() } });
		expect(outsider.ok()).toBeFalsy();
		const key = crypto.randomUUID();
		for (let attempt = 0; attempt < 2; attempt++) expect((await api.post('message/forward', { headers: { Authorization: `Bearer ${a.token}` }, data: { sourceId, room: target, type: 'private', clientMsgId: key } })).ok()).toBeTruthy();
		const history = await api.get('message/history', { headers: { Authorization: `Bearer ${a.token}` }, params: { room: target, type: 'private' } });
		expect((await history.json()).data.messages.filter((m: { content: string }) => m.content === '待引用转发的原文')).toHaveLength(2);
		await message.getByLabel('消息更多操作').click(); await page.getByRole('menuitem', { name: '本地隐藏', exact: true }).click();
		await expect(message).toHaveCount(0);
		const chat = page.locator(`[id="chatList_${room}"]`);
		await chat.click({ button: 'right' }); await page.getByRole('menuitem', { name: '置顶会话', exact: true }).click();
		await chat.click({ button: 'right' }); await page.getByRole('menuitem', { name: '消息免打扰', exact: true }).click();
		await page.reload(); await chat.click();
		await expect(chat.getByLabel('已置顶')).toBeVisible(); await expect(chat.getByLabel('免打扰')).toBeVisible();
		await expect(message).toHaveCount(0);
		const peerHistory = await api.get('message/history', { headers: { Authorization: `Bearer ${b.token}` }, params: { room, type: 'private' } });
		expect((await peerHistory.json()).data.messages.some((m: { id: number }) => m.id === sourceId)).toBe(true);
		expect((await api.post('message/recall', { headers: { Authorization: `Bearer ${b.token}` }, data: { messageId: sourceId, room, type: 'private' } })).ok()).toBeFalsy();
		await input.fill('即将撤回的消息'); await input.press('Enter');
		const retracting = page.locator('[data-message-index]').filter({ hasText: '即将撤回的消息' });
		await expect(retracting.getByRole('status', { name: '已发送', exact: true })).toBeVisible();
		const retractId = Number(await retracting.getAttribute('data-message-id'));
		await retracting.getByLabel('消息更多操作').click(); await page.getByRole('menuitem', { name: '撤回消息', exact: true }).click();
		await page.getByRole('dialog').getByRole('button', { name: /^撤\s*回$/ }).click();
		await expect(page.locator(`[data-message-id="${retractId}"]`).getByText('该消息已撤回', { exact: true })).toBeVisible();
		expect((await api.post('message/forward', { headers: { Authorization: `Bearer ${a.token}` }, data: { sourceId: retractId, room: target, type: 'private', clientMsgId: crypto.randomUUID() } })).ok()).toBeFalsy();
		const recalled = await api.get('message/history', { headers: { Authorization: `Bearer ${b.token}` }, params: { room, type: 'private' } });
		expect((await recalled.json()).data.messages.find((m: { id: number }) => m.id === retractId)).toMatchObject({ content: '该消息已撤回', recalled: true });
		await page.reload(); await chat.click();
		await expect(page.locator(`[data-message-id="${retractId}"]`).getByText('该消息已撤回', { exact: true })).toBeVisible();
	} finally { await api.dispose(); }
});

test('phone-only password recovery resets password and revokes previous session', async ({ page }) => {
	test.setTimeout(60000);
	const { api, a } = await setup();
	try {
		const invalid = await api.post('auth/recover_password', { data: { phone: 'invalid', password: 'NewPassword123!' } });
		expect(invalid.ok()).toBeFalsy();
		await page.goto('/login'); await page.getByText('忘记密码？', { exact: true }).click();
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('手机号', { exact: true }).fill(a.info.phone);
		await expect(dialog.getByLabel('恢复码', { exact: true })).toHaveCount(0);
		await dialog.getByLabel('新密码', { exact: true }).fill('NewPassword123!');
		await dialog.getByLabel('确认新密码', { exact: true }).fill('NewPassword123!');
		await dialog.getByRole('button', { name: '重置密码', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		expect((await api.get('message/chat_list', { headers: { Authorization: `Bearer ${a.token}` } })).status()).toBe(401);
		expect((await api.post('auth/login', { data: { username: a.username, password: a.password } })).ok()).toBeFalsy();
		await login(page, { username: a.username, password: 'NewPassword123!' });
	} finally { await api.dispose(); }
});
