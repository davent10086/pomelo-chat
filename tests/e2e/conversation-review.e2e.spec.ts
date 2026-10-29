// @tags assistant regression
import { test, expect } from '@playwright/test';
import { setup, login } from './helpers/chat';
import type { ReviewResult } from '../../client/src/components/ConversationReview/types';

const result = (room: string, id = 1, earlier = true): ReviewResult => ({
	room, coverage: { since: '2026-10-24', until: '2026-10-24', scannedMessages: 200,
		analyzedMessages: 199, skippedMedia: 1, contentTruncated: false, hasEarlier: earlier,
		newestId: id, nextBeforeId: id, capturedAt: '2026-10-24T08:00:00Z',
		oldestMessageAt: '2026-10-24T01:00:00Z', newestMessageAt: '2026-10-24T07:00:00Z' },
	topics: [], decisions: [{ text: '测试延期至周五', sources: [{ id, sender: '甲', content: '测试延期至周五', createdAt: '2026-10-24T07:00:00Z' }] }],
	questions: [], actions: [], answer: [], omittedItems: 0
});

test('review shows honest coverage, follows sources, asks against a snapshot and inserts a draft without sending', async ({ page }, testInfo) => {
	const { api, a, room } = await setup();
	const calls: Array<Record<string, unknown>> = [];
	let sourceId = 1;
	await page.route('**/assistant/agent/review', async route => {
		const body = route.request().postDataJSON(); calls.push(body);
		const review = result(room, sourceId);
		if (body.question) review.answer = [{ text: '请确认周五是否方便安排测试。', sources: review.decisions[0].sources }];
		if (body.beforeId === sourceId && !body.question) {
			review.coverage.hasEarlier = false;
			review.decisions[0].text = '较早分段的讨论';
		}
		await route.fulfill({ json: { code: 200, data: review } });
	});
	try {
		const loginResponse = page.waitForResponse(response => response.url().endsWith('/auth/login') && response.request().method() === 'POST');
		await login(page, a, room);
		const token = (await (await loginResponse).json()).data.token;
		await page.getByLabel('消息输入框').fill('测试延期至周五');
		await page.getByLabel('消息输入框').press('Enter');
		await expect(page.locator('[data-message-id]').filter({ hasText: '测试延期至周五' })).toBeVisible();
		const history = await api.get(`message/history?room=${encodeURIComponent(room)}&type=private`, { headers: { Authorization: `Bearer ${token}` } });
		sourceId = (await history.json()).data.messages[0].id;
		await page.getByRole('button', { name: '帮我跟上', exact: true }).click();
		const panel = page.getByRole('dialog', { name: /会话回顾/ });
		await expect(panel).toBeVisible();
		expect(calls).toHaveLength(0);
		await panel.getByLabel('回顾分析范围').selectOption('custom');
		await expect(panel.getByRole('button', { name: '开始回顾' })).toBeDisabled();
		await panel.getByLabel('回顾开始日期').fill('2026-10-24');
		await panel.getByLabel('回顾结束日期').fill('2026-10-24');
		await panel.getByRole('button', { name: '开始回顾' }).click();
		await expect(panel.getByText('测试延期至周五', { exact: true }).first()).toBeVisible();
		await expect(panel).toContainText('仅分析了部分消息');
		await expect(panel).toContainText('跳过 1 条非文字消息');
		expect(calls[0]).toEqual({ room, range: { preset: 'custom', since: '2026-10-24', until: '2026-10-24' } });
		await page.screenshot({ path: testInfo.outputPath('conversation-review.png') });
		await panel.getByRole('button', { name: '起草回复', exact: true }).click();
		await expect(panel.getByText('请确认周五是否方便安排测试。', { exact: true })).toBeVisible();
		expect(calls[1].beforeId).toBe(sourceId + 1);
		await panel.getByRole('button', { name: '填入输入框' }).click();
		await expect(page.getByLabel('消息输入框')).toHaveValue('请确认周五是否方便安排测试。');
		await expect(page.locator('[data-message-index]').getByText('请确认周五是否方便安排测试。')).toHaveCount(0);
		await page.getByRole('button', { name: '帮我跟上', exact: true }).click();
		await panel.getByRole('button', { name: '继续回顾更早消息' }).click();
		await expect(panel).toContainText('较早分段的讨论');
		expect(calls[2].beforeId).toBe(sourceId);
		await panel.getByLabel('回顾分段').selectOption('0');
		await panel.getByRole('button', { name: /查看来源消息/ }).first().click();
		await expect(panel).not.toBeVisible();
		await expect(page.getByRole('button', { name: '返回最新消息', exact: true })).toBeVisible();
	} finally { await api.dispose(); }
});

test('cancel, range changes and switching conversations discard late review results and allow retries', async ({ page }) => {
	const { api, a, room } = await setup();
	let release!: () => void;
	let started = 0;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	await page.route('**/assistant/agent/review', async route => {
		started++;
		if (started === 1) await blocked;
		const review = result(room);
		review.decisions[0].text = started === 1 ? '旧回顾结果' : '新的回顾结果';
		await route.fulfill({ json: { code: 200, data: review } }).catch(() => undefined);
	});
	try {
		await login(page, a, room);
		await page.getByRole('button', { name: '帮我跟上', exact: true }).click();
		const panel = page.getByRole('dialog', { name: /会话回顾/ });
		await panel.getByRole('button', { name: '开始回顾' }).click();
		await expect.poll(() => started).toBe(1);
		await panel.getByRole('button', { name: '停止生成' }).click();
		await panel.getByLabel('回顾分析范围').selectOption('week');
		release();
		await expect(panel.getByText('旧回顾结果')).toHaveCount(0);
		await panel.getByRole('button', { name: '开始回顾' }).click();
		await expect(panel).toContainText('新的回顾结果');
		await page.locator(`[id="chatList_ai_${a.info.id}"]`).click();
		await expect(panel).not.toBeVisible();
		await page.locator(`[id="chatList_${room}"]`).click();
		await page.getByRole('button', { name: '帮我跟上', exact: true }).click();
		await expect(panel.getByText('新的回顾结果')).toHaveCount(0);
	} finally { release(); await api.dispose(); }
});
