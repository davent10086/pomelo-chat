import { test, expect } from '@playwright/test';
import { setup, login } from './helpers/chat';

test('notification bursts share one list request and retain updates arriving during it', async ({ page }) => {
  const { api, a, room } = await setup();
  let notify!: () => void;
  let requests = 0, block = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.routeWebSocket('**/auth/user_channel?**', socket => {
    socket.connectToServer();
    notify = () => socket.send(JSON.stringify({ name: 'chatList' }));
  });
  await page.route('**/message/chat_list', async route => {
    requests++;
    if (block) await gate;
    await route.continue();
  });
  try {
    await login(page, a, room);
    await page.waitForTimeout(700);
    const before = requests;
    block = true;
    for (let index = 0; index < 100; index++) notify();
    await expect.poll(() => requests).toBe(before + 1);
    for (let index = 0; index < 100; index++) notify();
    await page.waitForTimeout(200);
    expect(requests).toBe(before + 1);
    block = false; release();
    await expect.poll(() => requests).toBe(before + 2);
    await page.waitForTimeout(700);
    expect(requests).toBe(before + 2);
    await expect(page.locator(`[id="chatList_${room}"]`)).toBeVisible();
  } finally { release(); await api.dispose(); }
});

test('variable-height long history stays virtualized and preserves the viewport on new messages', async ({ page }) => {
  const { api, a, b, room } = await setup();
  let push!: () => void;
  const row = (index: number) => ({
    id: index + 1, room_seq: index + 1, sender_id: b.info.id, receiver_id: a.info.id,
    room, content: `perf-row-${index}\n${'variable height\n'.repeat(index % 8)}`,
    type: 'text', created_at: '2026-10-27 12:00:00', file_size: '0 B'
  });
  await page.routeWebSocket('**/message/connect_chat?**', socket => {
    const server = socket.connectToServer();
    push = () => socket.send(JSON.stringify(row(5000)));
    server.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (frame.name === 'history') socket.send(JSON.stringify({
        ...frame, messages: Array.from({ length: 5000 }, (_, index) => row(index)), hasMore: false
      }));
      else socket.send(raw);
    });
  });
  const viewport = () => page.locator('[data-message-index]').evaluateAll(elements => {
    const container = elements[0]?.parentElement?.parentElement;
    if (!container) return undefined;
    const bounds = container.getBoundingClientRect();
    const visible = elements.find(element => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    }) as HTMLElement | undefined;
    return visible ? { id: visible.dataset.messageId, top: visible.getBoundingClientRect().top } : undefined;
  });
  try {
    await login(page, a, room);
    await expect(page.locator('[data-message-index]').filter({ hasText: 'perf-row-4999' })).toBeVisible();
    await page.locator('[data-message-index]').first().evaluate(element => {
      const container = element.parentElement!.parentElement!;
      container.dispatchEvent(new WheelEvent('wheel'));
      container.scrollTop = container.scrollHeight / 2;
    });
    await expect(page.getByRole('button', { name: '回到底部', exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    const before = await viewport();
    expect(before).toBeTruthy();
    expect(await page.locator('[data-message-index]').count()).toBeLessThan(150);
    push();
    await page.waitForTimeout(300);
    const after = await viewport();
    expect(after?.id).toBe(before?.id);
    expect(Math.abs(after!.top - before!.top)).toBeLessThan(3);
    await page.getByRole('button', { name: '回到底部', exact: true }).click();
    await expect(page.locator('[data-message-index]').filter({ hasText: 'perf-row-5000' })).toBeVisible();
  } finally { await api.dispose(); }
});
