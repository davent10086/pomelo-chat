import { test, expect, request } from '@playwright/test';
import { createUserFactory, connectFriends, login } from './helpers/chat';

test('an empty conversation compensates from zero when the first live frame has a gap', async ({ page }) => {
  const api = await request.newContext({ baseURL: 'http://127.0.0.1:3199/api/chat/v1/' });
  const create = createUserFactory(api, 'firstgap');
  try {
    const sender = await create(1), receiver = await create(2);
    const room = await connectFriends(api, sender, receiver);
    let heldFirst = false, sawSecond = false;
    await page.routeWebSocket('**/message/connect_chat?**', socket => {
      const server = socket.connectToServer();
      server.onMessage(raw => {
        const frame = JSON.parse(String(raw));
        if (frame.content === 'first frame withheld') { heldFirst = true; return; }
        if (frame.content === 'second frame arrives') sawSecond = true;
        socket.send(raw);
      });
    });
    await login(page, receiver);
    await page.locator(`[id="chatList_${room}"]`).click();
    await expect(page.getByLabel('消息输入框')).toBeEnabled();
    // Send using another real client; only the first incoming content frame is withheld.
    await page.evaluate(async ({ sender, room }) => {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:3199/api/chat/v1/message/connect_chat?room=${room}&id=${sender.info.id}&type=private`, ['pomelo-token', sender.token]);
        const timer = setTimeout(() => { ws.close(); reject(Error('Sender ACK timeout')); }, 10000);
        let index = 0;
        ws.onmessage = event => {
          const frame = JSON.parse(event.data);
          if (frame.name === 'history' || frame.name === 'ack') {
            if (index === 2) { clearTimeout(timer); ws.close(); resolve(); return; }
            ws.send(JSON.stringify({ content: ['first frame withheld', 'second frame arrives'][index++], type: 'text', clientMsgId: crypto.randomUUID() }));
          }
        };
      });
    }, { sender, room });
    await expect.poll(() => heldFirst && sawSecond).toBe(true);
    await expect(page.locator('[data-message-index]').getByText('first frame withheld', { exact: true })).toHaveCount(1);
    await expect(page.locator('[data-message-index]').getByText('second frame arrives', { exact: true })).toHaveCount(1);
  } finally { await api.dispose(); }
});
