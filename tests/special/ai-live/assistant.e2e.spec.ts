// @tags ai-live assistant
import { test, expect } from '@playwright/test';
import { setup, login } from '../../e2e/helpers/chat';

test('configured online model answers through the real browser conversation', async ({ page }) => {
  const { api, a } = await setup();
  try {
    await login(page, a);
    await page.locator(`[id="chatList_ai_${a.info.id}"]`).click();
    const response = page.waitForResponse(result => result.url().endsWith('/assistant/agent/stream'));
    const input = page.getByLabel('消息输入框');
    await input.fill('只回复“在线模型连通”，不要调用工具。'); await input.press('Enter');
    expect((await response).ok()).toBeTruthy();
    await expect(page.locator('[data-message-index]').getByText('在线模型连通', { exact: false }).last()).toBeVisible({ timeout: 90000 });
    await expect(page.getByLabel(/生成失败/)).toHaveCount(0);
  } finally { await api.dispose(); }
});
