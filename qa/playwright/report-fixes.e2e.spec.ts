import { test, expect } from '@playwright/test';
import { setup, login } from './helpers/chat';

test('router upgrade preserves auth redirects, navigation, reload and browser history', async ({ page }) => {
  const { api, a } = await setup();
  try {
    await page.goto('/files');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByRole('link', { name: /立即注册/ }).click();
    await expect(page).toHaveURL(/\/register$/);
    await page.getByRole('link', { name: /已有账号/ }).click();
    await expect(page).toHaveURL(/\/login$/);
    await login(page, a);
    for (const [label, route] of [['聊天文件', '/files'], ['通讯录', '/address-book'], ['聊天', '/chat']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${route}$`));
      await page.reload();
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
    }
    await page.goBack();
    await expect(page).toHaveURL(/\/address-book$/);
    await page.goForward();
    await expect(page).toHaveURL(/\/chat$/);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/chat');
    await expect(page).toHaveURL(/\/login$/);
  } finally { await api.dispose(); }
});

test('rapid Enter submits one message while IndexedDB persistence is pending', async ({ page }) => {
  const { api, a, room } = await setup();
  try {
    await login(page, a, room);
    const input = page.getByLabel('消息输入框');
    await input.fill('rapid-enter-regression');
    await input.evaluate(element => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const message = page.locator('[data-message-index]').filter({ hasText: 'rapid-enter-regression' });
    await expect(message.getByRole('status', { name: '已发送', exact: true })).toBeVisible();
    await expect(message).toHaveCount(1);
    const token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pomelo-chat.authToken') || '""'));
    const history = await api.get('message/history', { headers: { Authorization: `Bearer ${token}` }, params: { room, type: 'private' } });
    expect((await history.json()).data.messages.filter((item: { content: string }) => item.content === 'rapid-enter-regression')).toHaveLength(1);
    await expect(input).toHaveValue('');
  } finally { await api.dispose(); }
});

test('a forbidden room response preserves the browser login session', async ({ page }) => {
  const { api, a, room } = await setup();
  try {
    await login(page, a, room);
    const token = await page.evaluate(() => sessionStorage.getItem('pomelo-chat.authToken'));
    await page.evaluate(async () => {
      const module = await import('/src/utils/request.ts');
      try { await module.default.get('/message/history', { params: { room: 'unavailable-room', type: 'group' } }); } catch { /* expected 403 */ }
    });
    expect(await page.evaluate(() => sessionStorage.getItem('pomelo-chat.authToken'))).toBe(token);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByLabel('消息输入框')).toBeVisible();
  } finally { await api.dispose(); }
});
