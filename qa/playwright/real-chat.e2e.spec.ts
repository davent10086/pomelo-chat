import { createUserFactory, connectFriends, login } from './helpers/chat';
import { test, expect, request } from '@playwright/test';
import { createHash } from 'node:crypto';

// No response stubs or WebSocket interception: both browsers use the running app.
test('真实聊天：登录、通知、上传下载与断线恢复', async ({ page, browser }) => {
  test.setTimeout(90000);
  const api = await request.newContext({ baseURL: 'http://127.0.0.1:3199/api/chat/v1/' });
  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  const stamp = Date.now();
  const notifications: string[] = [];
  peer.on('websocket', socket => {
    if (socket.url().includes('/auth/user_channel'))
      socket.on('framereceived', frame => notifications.push(String(frame.payload)));
  });
  const create = createUserFactory(api, 'real');
  try {
    const a = await create(1), b = await create(2), outsider = await create(3);
    const room = await connectFriends(api, a, b);
    await login(page, a);
    await login(peer, b);
    a.token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pomelo-chat.authToken') || '""'));
    b.token = await peer.evaluate(() => JSON.parse(sessionStorage.getItem('pomelo-chat.authToken') || '""'));
    await page.locator(`[id="chatList_${room}"]`).click();
    const input = page.getByLabel('消息输入框');
    await input.fill(`真实消息_${stamp}`);
    await input.press('Enter');
    const firstMessage = page.locator('[data-message-index]').filter({ hasText: `真实消息_${stamp}` });
    await expect(firstMessage.getByRole('status', { name: '已发送', exact: true })).toBeVisible();
    await expect.poll(() => notifications.some(raw => JSON.parse(raw).name === 'chatList')).toBeTruthy();
    await peer.locator(`[id="chatList_${room}"]`).click();
    await expect(peer.locator('[data-message-index]').getByText(`真实消息_${stamp}`, { exact: true })).toHaveCount(1);
    await expect(firstMessage.getByRole('status', { name: '对方已读', exact: true })).toBeVisible();
    await expect(firstMessage.getByRole('status', { name: '对方已读', exact: true }).locator('svg path')).toHaveCount(2);
    await page.reload();
    await page.locator(`[id="chatList_${room}"]`).click();
    await expect(firstMessage.getByRole('status', { name: '对方已读', exact: true })).toBeVisible();

    const bytes = Buffer.from(`真实文件内容_${stamp}`);
    const mergedResponse = page.waitForResponse(response => response.url().endsWith('/file/merge_chunk'));
    await page.locator('input[type=file]').last().setInputFiles({ name: 'real-chat.txt', mimeType: 'text/plain', buffer: bytes });
    const merged = await mergedResponse;
    expect(merged.ok()).toBeTruthy();
    const filePath = (await merged.json()).data.filePath;
    await expect.poll(async () => {
      const response = await api.get('message/search', { headers: { Authorization: `Bearer ${b.token}` }, params: { room, type: 'private', mediaType: 'file' } });
      expect(response.ok()).toBeTruthy();
      return (await response.json()).data.messages.filter((message: { content: string }) => message.content === filePath).map((message: { file_name: string }) => message.file_name);
    }).toEqual(['real-chat.txt']);
    const download = await api.get(`http://127.0.0.1:3199${filePath}`, { headers: { Authorization: `Bearer ${b.token}` } });
    expect(download.ok()).toBeTruthy();
    expect(createHash('sha256').update(await download.body()).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    const forbidden = await api.get(`http://127.0.0.1:3199${filePath}`, { headers: { Authorization: `Bearer ${outsider.token}` } });
    expect(forbidden.status()).toBe(404);

    // File drags use the same real upload path, without navigating away or replacing a text draft.
    await input.fill('拖文件不覆盖正文草稿');
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(['dragged-file-one'], 'drag-one.txt', { type: 'text/plain' }));
      data.items.add(new File(['dragged-file-two'], 'drag-two.txt', { type: 'text/plain' }));
      return data;
    });
    const area = page.getByRole('region', { name: '聊天区域', exact: true });
    await area.dispatchEvent('dragenter', { dataTransfer: transfer });
    await expect(page.getByText('松开即可上传并发送文件')).toBeVisible();
    await area.dispatchEvent('drop', { dataTransfer: transfer });
    await expect(page.getByText('松开即可上传并发送文件')).toHaveCount(0);
    await expect(input).toHaveValue('拖文件不覆盖正文草稿');
    await expect.poll(async () => {
      const result = await api.get('message/search', { headers: { Authorization: `Bearer ${b.token}` }, params: { room, type: 'private', mediaType: 'file' } });
      return (await result.json()).data.messages.length;
    }).toBe(3);
    const allFiles = (await (await api.get('message/search', { headers: { Authorization: `Bearer ${b.token}` }, params: { room, type: 'private', mediaType: 'file' } })).json()).data.messages;
    for (const [text, index] of [['dragged-file-one', 0], ['dragged-file-two', 1]] as const) {
      const path = allFiles.filter((item: { content: string }) => item.content !== filePath).sort((a: { id: number }, b: { id: number }) => a.id - b.id)[index].content;
      expect(await (await api.get(`http://127.0.0.1:3199${path}`, { headers: { Authorization: `Bearer ${b.token}` } })).text()).toBe(text);
    }
    await transfer.dispose();

    const tooMany = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      for (let i = 0; i < 11; i++) data.items.add(new File(['x'], `too-many-${i}.txt`, { type: 'text/plain' }));
      return data;
    });
    await area.dispatchEvent('drop', { dataTransfer: tooMany });
    await expect(page.getByText('一次最多发送 10 个文件')).toBeVisible();
    await tooMany.dispose();

    // Close the receiver's real transport, send while disconnected, then recover via UI.
    await peer.goto('about:blank');
    await input.fill(`离线消息_${stamp}`);
    await input.press('Enter');
    const offlineMessage = page.locator('[data-message-index]').filter({ hasText: `离线消息_${stamp}` });
    await expect(offlineMessage.getByRole('status', { name: '已发送', exact: true })).toBeVisible();
    await expect.poll(async () => {
      const response = await api.get('message/search', { headers: { Authorization: `Bearer ${a.token}` }, params: { room, type: 'private', query: `离线消息_${stamp}` } });
      return (await response.json()).data.messages.length;
    }).toBe(1);
    await peer.goto('http://127.0.0.1:5199/');
    await peer.locator(`[id="chatList_${room}"]`).click();
    await expect(peer.locator('[data-message-index]').getByText(`离线消息_${stamp}`, { exact: true })).toHaveCount(1);
    await expect(offlineMessage.getByRole('status', { name: '对方已读', exact: true })).toBeVisible();
    await peer.reload();
    await peer.locator(`[id="chatList_${room}"]`).click();
    await expect(peer.locator('[data-message-index]').getByText(`离线消息_${stamp}`, { exact: true })).toHaveCount(1);
  } finally {
    await peerContext.close();
    await api.dispose();
  }
});
