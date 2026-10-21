import { testApiOrigin } from "./helpers/endpoints";
import { test, expect } from '@playwright/test';
import { setup, login } from './helpers/chat';

test('overload keeps the pending message, retries the same ID and reports real client receipt', async ({ page, browser }) => {
  const { api, a, b, room } = await setup();
  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  const attempts: string[] = [];
  const content = `overload-browser-${Date.now()}`;
  await page.routeWebSocket('**/message/connect_chat?**', socket => {
    const server = socket.connectToServer();
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (frame.content === content) {
        attempts.push(frame.clientMsgId);
        if (attempts.length === 1) {
          socket.send(JSON.stringify({ name: 'error', code: 'MESSAGE_OVERLOADED',
            client_msg_id: frame.clientMsgId, retryable: true, retryAfterMs: 3000, message: '发送繁忙' }));
          return;
        }
      }
      server.send(raw);
    });
  });
  const receiptCount = async () => {
    const res = await api.get(`${testApiOrigin}/internal/metrics`, {
      headers: { Authorization: 'Bearer browser-metrics-test' }
    });
    expect(res.status()).toBe(200);
    return Number(/pomelo_message_socket_receive_seconds_count (\d+)/.exec(await res.text())?.[1] || 0);
  };
  try {
    await login(page, a, room); await login(peer, b, room);
    const before = await receiptCount();
    await page.getByLabel('消息输入框').fill(content);
    await page.getByLabel('消息输入框').press('Enter');
    await expect.poll(() => attempts.length).toBe(1);
    const pending = () => page.evaluate(async ({ userId, roomId }) => {
      const path = '/src/utils/pending-messages.ts';
      const store = await import(path);
      return (await store.listPendingMessages(userId, roomId)).length;
    }, { userId: a.info.id, roomId: room });
    await expect.poll(pending).toBe(1);
    const own = page.locator('[data-message-index]').filter({ hasText: content });
    await expect(own.getByRole('status', { name: /^(已发送|对方已读)$/ })).toBeVisible({ timeout: 10000 });
    await expect(peer.locator('[data-message-index]').getByText(content, { exact: true })).toHaveCount(1);
    expect(attempts.length).toBe(2); expect(new Set(attempts).size).toBe(1);
    await expect.poll(pending).toBe(0);
    await expect.poll(receiptCount).toBeGreaterThan(before);
  } finally { await peerContext.close(); await api.dispose(); }
});
