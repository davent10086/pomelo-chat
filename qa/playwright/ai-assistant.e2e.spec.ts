import { test, expect, request as playwrightRequest } from '@playwright/test';

const appUrl = process.env.QA_APP_URL || 'http://127.0.0.1:5173';
const apiBase = process.env.QA_API_BASE || 'http://127.0.0.1:3000/api/chat/v1';

test('login and chat with built-in AI assistant', async ({ page }) => {
  const api = await playwrightRequest.newContext({ baseURL: apiBase });
  const runId = Date.now();
  const username = `qa_e2e_${runId}`;
  const password = 'Qa123456!';
  const phone = `13${String(runId).slice(-9).padStart(9, '0')}`;

  await api.post('/auth/register', {
    data: { username, password, phone, avatar: '' }
  });

  await page.goto(`${appUrl}/login`);
  await page.locator('input').nth(0).fill(username);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();

  await expect(page).toHaveURL(/\/($|chat|address-book)/, { timeout: 15000 });

  await page.goto(`${appUrl}/address-book`);
  await page.getByText('AI', { exact: true }).click();

  const textarea = page.locator('textarea');
  await expect(textarea).toBeVisible({ timeout: 10000 });
  await textarea.fill('你好，你是谁？');
  await page.locator('button').filter({ hasText: /发送|鍙戦€/ }).last().click();

  await expect(page.locator('text=Pomelo').or(page.locator('text=AI'))).toBeVisible({ timeout: 60000 });
});
