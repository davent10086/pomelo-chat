// @tags ai-live assistant regression
import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { setup, login } from '../../e2e/helpers/chat';
import type { ReviewResult } from '../../../client/src/components/ConversationReview/types';

test.setTimeout(180000);
test.use({ actionTimeout: 15000 });

test('real model reviews persisted chat, cites sources, answers and drafts through the browser', async ({ page }, testInfo) => {
	const { api, a, room } = await setup();
	const samples = [
		'上线安排：暂定周五上线。',
		'变更：周五上线已取消，最终决定下周一上线，原因是支付回归失败。',
		'行动事项：小王负责修复支付回归问题，截止周日。',
		'待确认：灰度比例是多少？目前尚未决定，需要产品负责人确认。',
		'说明：设计稿已完成，不再列入待办。'
	];
	const measurements: Array<{ step: string; milliseconds: number; result: ReviewResult }> = [];
	try {
		const loginResponse = page.waitForResponse(response => response.url().endsWith('/auth/login') && response.request().method() === 'POST');
		await login(page, a, room);
		const token = (await (await loginResponse).json()).data.token;
		const input = page.getByLabel('消息输入框');
		for (const content of samples) {
			await input.fill(content); await input.press('Enter');
			await expect(page.locator('[data-message-id]').filter({ hasText: content })).toBeVisible();
		}
		const history = async () => {
			const response = await api.get(`message/history?room=${encodeURIComponent(room)}&type=private`, {
				headers: { Authorization: `Bearer ${token}` }
			});
			expect(response.ok()).toBeTruthy();
			return (await response.json()).data.messages as Array<{ id: number; content: string }>;
		};
		const persisted = await history();
		expect(persisted.map(message => message.content)).toEqual(samples);
		const ids = new Set(persisted.map(message => message.id));
		const measure = async (step: string, action: () => Promise<unknown>) => {
			const start = Date.now();
			const responsePromise = page.waitForResponse(response => response.url().endsWith('/assistant/agent/review'), { timeout: 125000 });
			await action();
			const response = await responsePromise;
			const body = await response.json();
			expect(response.ok(), JSON.stringify(body)).toBeTruthy();
			expect(body.code, JSON.stringify(body)).toBe(200);
			const result = body.data as ReviewResult;
			measurements.push({ step, milliseconds: Date.now() - start, result });
			expect(result.coverage.analyzedMessages).toBe(samples.length);
			expect(result.coverage.hasEarlier).toBe(false);
			expect(result.omittedItems).toBe(0);
			for (const item of [...result.topics, ...result.decisions, ...result.questions, ...result.actions, ...result.answer]) {
				expect(item.sources.length).toBeGreaterThan(0);
				for (const source of item.sources) {
					expect(ids.has(source.id)).toBeTruthy();
					expect(source.content).toBe(persisted.find(message => message.id === source.id)!.content);
				}
			}
			console.log(`[ai-live-review] ${step}: ${Date.now() - start}ms`);
			return result;
		};
		await page.getByRole('button', { name: '帮我跟上', exact: true }).click();
		const panel = page.getByRole('dialog', { name: /会话回顾/ });
		const review = await measure('review', () => panel.getByRole('button', { name: '开始回顾' }).click());
		expect(review.decisions.map(item => item.text).join('\n')).toContain('下周一');
		expect(review.actions.some(item => /支付/.test(item.text) && /小王/.test(`${item.text}${item.assignee || ''}`))).toBeTruthy();
		expect(review.actions.some(item => /设计稿/.test(item.text))).toBe(false);
		expect(review.questions.map(item => item.text).join('\n')).toContain('灰度');
		await panel.getByRole('button', { name: /查看来源消息/ }).first().click();
		await expect(page.getByRole('button', { name: '返回最新消息', exact: true })).toBeVisible();
		await page.getByRole('button', { name: '帮我跟上', exact: true }).click();
		await panel.getByLabel('会话回顾追问').fill('最终何时上线，为什么？');
		const answer = await measure('followup', () => panel.getByRole('button', { name: /提\s*问/ }).click());
		expect(answer.answer.map(item => item.text).join('\n')).toMatch(/下周一/);
		expect(answer.answer.map(item => item.text).join('\n')).toMatch(/支付/);
		await measure('draft', () => panel.getByRole('button', { name: '起草回复', exact: true }).first().click());
		await panel.getByRole('button', { name: '填入输入框', exact: true }).last().click();
		await expect(input).not.toHaveValue('');
		expect((await input.inputValue()).length).toBeGreaterThan(5);
		expect(await history()).toEqual(persisted);
		await page.screenshot({ path: testInfo.outputPath('live-draft.png') });
	} finally {
		await writeFile(testInfo.outputPath('live-review-results.json'), JSON.stringify(measurements, null, 2));
		await api.dispose();
	}
});
