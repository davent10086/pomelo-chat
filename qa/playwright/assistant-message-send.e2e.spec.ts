import { test, expect } from '@playwright/test';
import { setup, login, connectFriends } from './helpers/chat';
import { createRequire } from 'node:module';
import path from 'node:path';

test('assistant draft binds an explicit recipient and confirms real private and group delivery', async ({ page, browser }) => {
	test.setTimeout(60000);
	const { api, a, b, room, create } = await setup();
	const outsider = await create(3);
	const context = await browser.newContext();
	const peer = await context.newPage();
	const marker = `assistant_send_${Date.now()}`;
	try {
		const headers = { Authorization: `Bearer ${a.token}` };
		expect((await api.post('group/create_group', { headers, data: {
			name: marker, avatar: '', announcement: '', members: [{ user_id: b.info.id, username: b.username }]
		} })).ok()).toBeTruthy();
		const groups = (await (await api.get('group/group_list', { headers })).json()).data;
		const groupRoom = groups.find((item: { name: string }) => item.name === marker).room;
		await page.route('**/assistant/agent/stream', route => route.fulfill({
			contentType: 'text/event-stream',
			body: `data: ${JSON.stringify({ content: '请核对收件人再发送', draftMessage: marker, actions: [] })}\n\ndata: [DONE]\n\n`
		}));
		await login(page, a);
		a.token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pomelo-chat.authToken') || '""'));
		headers.Authorization = `Bearer ${a.token}`;
		await login(peer, b, room);
		await page.locator(`[id="chatList_ai_${a.info.id}"]`).click();
		await page.getByLabel('消息输入框').fill('帮我代写一条消息');
		await page.getByLabel('消息输入框').press('Enter');
		const draft = page.getByRole('region', { name: '草稿发送', exact: true });
		await expect(draft).toBeVisible();
		await expect(draft.getByRole('button', { name: '核对发送信息' })).toBeDisabled();
		await draft.getByLabel('选择消息收件人').selectOption(room);
		const prepareResponse = page.waitForResponse(r => r.url().endsWith('/actions/message-draft'));
		await draft.getByRole('button', { name: '核对发送信息' }).click();
		const action = (await (await prepareResponse).json()).data.action;
		expect(action.payload.receiverId).toBe(b.info.id);
		await expect(draft.getByLabel('发送确认信息')).toContainText(b.username);
		const search = async (target: string, type: string, query: string) =>
			(await (await api.get('message/search', { headers, params: { room: target, type, query } })).json()).data.messages;
		expect(await search(room, 'private', marker)).toHaveLength(0);
		const foreign = await api.post('assistant/actions/confirm', {
			headers: { Authorization: `Bearer ${outsider.token}` }, data: { confirmationId: action.confirmationId }
		});
		expect(foreign.status()).toBe(404);
		await draft.getByRole('button', { name: '确认发送', exact: true }).click();
		await expect(draft.getByText('已完成', { exact: true })).toBeVisible();
		await expect(peer.locator('[data-message-index]').getByText(marker, { exact: true })).toHaveCount(1);
		expect((await api.post('assistant/actions/confirm', { headers, data: { confirmationId: action.confirmationId } })).ok()).toBeTruthy();
		expect(await search(room, 'private', marker)).toHaveLength(1);

		await draft.getByLabel('选择消息收件人').selectOption(groupRoom);
		await draft.getByLabel('待发送消息正文').fill(`${marker}_group`);
		await draft.getByRole('button', { name: '核对发送信息' }).click();
		await expect(draft.getByLabel('发送确认信息')).toContainText('群聊');
		await draft.getByRole('button', { name: '确认发送', exact: true }).click();
		await expect(draft.getByText('已完成', { exact: true })).toBeVisible();
		await peer.reload();
		await peer.locator(`[id="chatList_${groupRoom}"]`).click();
		await expect(peer.locator('[data-message-index]').getByText(`${marker}_group`, { exact: true })).toHaveCount(1);

		await draft.getByLabel('待发送消息正文').fill(`${marker}_cancel`);
		const cancelPreparation = page.waitForResponse(r => r.url().endsWith('/actions/message-draft'));
		await draft.getByRole('button', { name: '核对发送信息' }).click();
		const cancelled = (await (await cancelPreparation).json()).data.action;
		await draft.getByRole('button', { name: /^取\s*消$/ }).click();
		await expect(draft.getByText('已取消', { exact: true })).toBeVisible();
		expect((await api.post('assistant/actions/confirm', { headers, data: { confirmationId: cancelled.confirmationId } })).ok()).toBeFalsy();
		expect(await search(groupRoom, 'group', `${marker}_cancel`)).toHaveLength(0);

		for (const data of [
			{ room, chatType: 'group', content: marker },
			{ room: 'unavailable-room', chatType: 'private', content: marker },
			{ room, chatType: 'private', content: '' },
			{ room, chatType: 'private', content: 'x'.repeat(10001) }
		]) expect((await api.post('assistant/actions/message-draft', { headers, data })).ok()).toBeFalsy();
		const denied = await api.post('assistant/actions/message-draft', {
			headers: { Authorization: `Bearer ${outsider.token}` }, data: { room, chatType: 'private', content: marker }
		});
		expect(denied.status()).toBe(404);
	} finally { await context.close(); await api.dispose(); }
});

test('changing recipient cancels the old action and ignores a late preparation response', async ({ page }) => {
	const { api, a, b, room, create } = await setup();
	const c = await create(3);
	const otherRoom = await connectFriends(api, a, c);
	const friendGroups = (await (await api.get('friend/friend_list', {
		headers: { Authorization: `Bearer ${a.token}` }
	})).json()).data;
	for (const group of friendGroups) for (const friend of group.friend) {
		if ([b.username, c.username].includes(friend.username)) {
			expect((await api.post('friend/update_friend', {
				headers: { Authorization: `Bearer ${a.token}` },
				data: { friend_id: friend.id, group_id: friend.group_id, remark: '同名联系人' }
			})).ok()).toBeTruthy();
		}
	}
	let release!: () => void;
	const wait = new Promise<void>(resolve => { release = resolve; });
	let delayed = false;
	let requests = 0;
	await page.route('**/assistant/agent/stream', route => route.fulfill({ contentType: 'text/event-stream',
		body: `data: ${JSON.stringify({ content: '草稿', draftMessage: '不可错投的消息', actions: [] })}\n\ndata: [DONE]\n\n` }));
	await page.route('**/actions/message-draft', async route => {
		const response = await route.fetch();
		if (++requests === 2) { delayed = true; await wait; }
		await route.fulfill({ response }).catch(() => undefined);
	});
	try {
		await login(page, a);
		a.token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pomelo-chat.authToken') || '""'));
		await page.locator(`[id="chatList_ai_${a.info.id}"]`).click();
		await page.getByLabel('消息输入框').fill('请生成草稿');
		await page.getByLabel('消息输入框').press('Enter');
		const draft = page.getByRole('region', { name: '草稿发送', exact: true });
		await expect(draft.getByLabel('选择消息收件人').locator('option').filter({ hasText: '同名联系人' })).toHaveCount(2);
		await draft.getByLabel('选择消息收件人').selectOption(room);
		const prepared = page.waitForResponse(r => r.url().endsWith('/actions/message-draft'));
		await draft.getByRole('button', { name: '核对发送信息' }).click();
		const old = (await (await prepared).json()).data.action;
		await expect(draft.getByLabel('发送确认信息')).toContainText(b.username);
		await draft.getByLabel('选择消息收件人').selectOption(otherRoom);
		await expect(draft.getByRole('button', { name: '确认发送', exact: true })).toHaveCount(0);
		await expect.poll(async () => (await (await api.get(`assistant/actions/${old.confirmationId}`, {
			headers: { Authorization: `Bearer ${a.token}` }
		})).json()).data.status).toBe('cancelled');
		await draft.getByRole('button', { name: '核对发送信息' }).click();
		await expect.poll(() => delayed).toBe(true);
		await draft.getByLabel('选择消息收件人').selectOption(room);
		release();
		await expect(draft.getByRole('button', { name: '核对发送信息' })).toBeEnabled();
		await expect(draft.getByLabel('发送确认信息')).toHaveCount(0);
		await draft.getByRole('button', { name: '核对发送信息' }).click();
		await expect(draft.getByLabel('发送确认信息')).toContainText(b.username);
		await expect(draft.getByLabel('发送确认信息')).not.toContainText(c.username);
	} finally { release(); await api.dispose(); }
});

test('message confirmation rechecks membership after a reviewed recipient loses access', async () => {
	const { api, a, b } = await setup();
	const marker = `revoked_assistant_${Date.now()}`;
	const headers = { Authorization: `Bearer ${a.token}` };
	let db: { execute: (sql: string, bindings: number[]) => Promise<unknown>; end: () => Promise<void> } | undefined;
	try {
		expect((await api.post('group/create_group', { headers, data: {
			name: marker, avatar: '', announcement: '', members: [{ user_id: b.info.id, username: b.username }]
		} })).ok()).toBeTruthy();
		const groups = (await (await api.get('group/group_list', { headers })).json()).data;
		const group = groups.find((item: { name: string }) => item.name === marker);
		const groupId = Number(group.id ?? group.group_id);
		expect(Number.isSafeInteger(groupId)).toBeTruthy();
		const preparation = await api.post('assistant/actions/message-draft', { headers, data: {
			room: group.room, chatType: 'group', content: marker,
			name: '伪造名称', receiverId: b.info.id
		} });
		expect(preparation.ok()).toBeTruthy();
		const action = (await preparation.json()).data.action;
		expect(action.payload.name).toBe(marker);
		expect(action.payload.receiverId).toBe(groupId);
		const databaseUrl = process.env.DATABASE_URL_TEST!;
		if (!decodeURIComponent(new URL(databaseUrl).pathname).includes('test')) throw new Error('Refusing non-test database');
		const require = createRequire(path.resolve('server/package.json'));
		db = await require('mysql2/promise').createConnection(databaseUrl);
		await db!.execute('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, a.info.id]);
		const confirm = await api.post('assistant/actions/confirm', { headers, data: { confirmationId: action.confirmationId } });
		expect(confirm.ok()).toBeFalsy();
		const search = await api.get('message/search', {
			headers: { Authorization: `Bearer ${b.token}` }, params: { room: group.room, type: 'group', query: marker }
		});
		expect(search.ok()).toBeTruthy();
		expect((await search.json()).data.messages).toHaveLength(0);
	} finally { await db?.end(); await api.dispose(); }
});
