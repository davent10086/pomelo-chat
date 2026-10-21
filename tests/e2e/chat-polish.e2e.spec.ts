import { test, expect } from '@playwright/test';
import { setup, login } from './helpers/chat';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

test('attachment names survive reload, file library supports downloads and navigation, local icons survive blocked external hosts', async ({ page }) => {
	test.setTimeout(60000);
	const { api, a, room } = await setup();
	await page.route(/https:\/\/(img\.qovv\.cn|p[01]\.meituan\.net|ui-avatars\.com)\//, route => route.abort());
	const filename = '会议纪要（草案）2026.txt';
	const bytes = Buffer.from('original filename and download integrity');
	try {
		await login(page, a, room);
		const stored = page.waitForResponse(response => response.url().endsWith('/file/merge_chunk'));
		await page.locator('input[type=file]').last().setInputFiles({ name: filename, mimeType: 'text/plain', buffer: bytes });
		const filePath = (await (await stored).json()).data.filePath as string;
		await expect(page.getByRole('button', { name: `下载文件 ${filename}`, exact: true })).toBeVisible();
		await expect(page.locator('[data-message-index]').filter({ hasText: filename }).getByRole('status', { name: '已发送', exact: true })).toBeVisible();
		await page.reload();
		await page.locator(`[id="chatList_${room}"]`).click();
		await expect(page.getByRole('button', { name: `下载文件 ${filename}`, exact: true })).toBeVisible();
		const downloadReady = page.waitForEvent('download');
		await page.getByRole('button', { name: `下载文件 ${filename}`, exact: true }).click();
		const download = await downloadReady;
		expect(download.suggestedFilename()).toBe(filename);
		expect(createHash('sha256').update(await fs.readFile((await download.path())!)).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
		await page.getByRole('button', { name: '聊天文件', exact: true }).click();
		await expect(page).toHaveURL(/\/files$/);
		await expect(page.getByRole('region', { name: '聊天文件', exact: true })).toBeVisible();
		await expect(page.getByText(filename, { exact: true })).toBeVisible();
		await expect.poll(() => page.locator('img[src^="/ui-assets/"]').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
		await page.reload();
		await expect(page.getByRole('region', { name: '聊天文件', exact: true })).toBeVisible();
		await expect(page.getByText(filename, { exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: '刷新聊天文件', exact: true })).toBeEnabled();
		await page.screenshot({ path: 'test-results/chat-files-desktop.png', animations: 'disabled' });
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(page.getByRole('button', { name: `下载 ${filename}`, exact: true })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.screenshot({ path: 'test-results/chat-files-mobile.png' });
		const replay = await page.evaluate(async ({ room, filePath, filename }) => {
      const { wsBaseURL: testWsBaseURL, apiBaseURL: testBrowserApiURL } = await import("/src/config/index.ts");

			const token = JSON.parse(sessionStorage.getItem('pomelo-chat.authToken')!);
			const user = JSON.parse(sessionStorage.getItem('pomelo-chat.userInfo')!);
			const result = await new Promise<{ id: number; repeatedId: number; conflict: string; clientMsgId: string }>((resolve, reject) => {
				const socket = new WebSocket(`${testWsBaseURL}/message/connect_chat?room=${room}&id=${user.id}&type=private`, ['pomelo-token', token]);
				const payload = { content: filePath, type: 'file', fileName: filename, clientMsgId: `name_${crypto.randomUUID()}` };
				let original = 0, repeated = 0;
				const timer = setTimeout(() => { socket.close(); reject(new Error('Attachment replay timeout')); }, 10000);
				socket.onmessage = event => {
					const frame = JSON.parse(event.data);
					if (frame.name === 'history') socket.send(JSON.stringify(payload));
					if (frame.name === 'ack' && !original) { original = frame.id; socket.send(JSON.stringify(payload)); }
					else if (frame.name === 'ack') { repeated = frame.id; socket.send(JSON.stringify({ ...payload, fileName: '另一个名字.txt' })); }
					if (frame.name === 'error') { clearTimeout(timer); socket.close(); resolve({ id: original, repeatedId: repeated, conflict: frame.name, clientMsgId: payload.clientMsgId }); }
				};
			});
			const response = await fetch(`${testBrowserApiURL}/message/resolve`, {
				method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ room, type: 'private', clientMsgIds: [result.clientMsgId] })
			});
			return { ...result, resolved: (await response.json()).data.messages };
		}, { room, filePath, filename });
		expect(replay.id).toBeGreaterThan(0);
		expect(replay.repeatedId).toBe(replay.id);
		expect(replay.conflict).toBe('error');
		expect(replay.resolved).toHaveLength(1);
		expect(replay.resolved[0].file_name).toBe(filename);
	} finally { await api.dispose(); }
});

test('next-step suggestions are requested from the composer and insert without sending', async ({ page }) => {
	const { api, a, room } = await setup();
	let requests = 0;
	await page.route('**/assistant/agent', route => {
		requests++;
		return route.fulfill({ json: { code: 200, data: { content: '建议', replySuggestions: ['请确认会议时间', '我来整理会议纪要'] } } });
	});
	try {
		await login(page, a, room);
		const input = page.getByLabel('消息输入框');
		await input.fill('讨论会议安排'); await input.press('Enter');
		await expect(page.locator('[data-message-index]').getByText('讨论会议安排', { exact: true })).toBeVisible();
		expect(requests).toBe(0);
		await input.fill('原有草稿：');
		const trigger = page.getByRole('button', { name: '下一步建议', exact: true });
		const triggerBox = (await trigger.boundingBox())!, inputBox = (await input.boundingBox())!;
		expect(Math.abs(triggerBox.y - inputBox.y)).toBeLessThan(180);
		await trigger.click();
		await expect(page.getByRole('region', { name: '下一步建议', exact: true })).toBeVisible();
		await page.screenshot({ path: 'test-results/composer-suggestions-desktop.png', animations: 'disabled' });
		await page.getByRole('button', { name: '请确认会议时间', exact: true }).click();
		await expect(input).toHaveValue('原有草稿：请确认会议时间');
		await expect(page.locator('[data-message-index]').getByText('原有草稿：请确认会议时间', { exact: true })).toHaveCount(0);
		expect(requests).toBe(1);
		await page.setViewportSize({ width: 390, height: 844 });
		await trigger.click();
		await expect(page.getByRole('button', { name: '我来整理会议纪要', exact: true })).toBeVisible();
		await expect.poll(() => page.getByRole('region', { name: '下一步建议', exact: true }).evaluate(element => {
			const box = element.getBoundingClientRect();
			const popup = element.closest('.ant-popover')!;
			return JSON.stringify({ left: box.left, right: box.right, top: box.top, bottom: box.bottom, opacity: getComputedStyle(popup).opacity,
				inside: getComputedStyle(popup).opacity === '1' && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight });
		})).toContain('"inside":true');
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.screenshot({ path: 'test-results/composer-suggestions-mobile.png', animations: 'disabled' });
	} finally { await api.dispose(); }
});
