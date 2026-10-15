import { test, expect, request, type Page } from '@playwright/test';
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
  const create = async (index: number) => {
    const username = `real_${stamp}_${index}`, password = 'RealChat123!';
    const registered = await api.post('auth/register', { data: {
      username, password, phone: `13${String(stamp + index).slice(-9)}`, avatar: ''
    } });
    expect(registered.ok()).toBeTruthy();
    const logged = await api.post('auth/login', { data: { username, password } });
    expect(logged.ok()).toBeTruthy();
    return { username, password, ...(await logged.json()).data };
  };
  const login = async (target: Page, user: { username: string; password: string }) => {
    await target.goto('http://127.0.0.1:5199/login');
    await target.getByPlaceholder('请输入用户名').fill(user.username);
    await target.getByPlaceholder('请输入密码').fill(user.password);
    await target.locator('button[type=submit]').click();
    await expect(target).toHaveURL(/\/$/);
  };
  try {
    const a = await create(1), b = await create(2), outsider = await create(3);
    const added = await api.post('friend/add_friend', {
      headers: { Authorization: `Bearer ${a.token}` }, data: { id: b.info.id, username: b.username }
    });
    expect(added.ok()).toBeTruthy();
    const list = await api.get('message/chat_list', { headers: { Authorization: `Bearer ${a.token}` } });
    const room = (await list.json()).data[0].room;
    await login(page, a);
    await login(peer, b);
    a.token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pomelo-chat.authToken') || '""'));
    b.token = await peer.evaluate(() => JSON.parse(sessionStorage.getItem('pomelo-chat.authToken') || '""'));
    await page.locator(`[id="chatList_${room}"]`).click();
    const input = page.getByLabel('消息输入框');
    await input.fill(`真实消息_${stamp}`);
    await input.press('Enter');
    await expect(page.getByText('已发送', { exact: true })).toBeVisible();
    await expect.poll(() => notifications.some(raw => JSON.parse(raw).name === 'chatList')).toBeTruthy();
    await peer.locator(`[id="chatList_${room}"]`).click();
    await expect(peer.locator('[data-message-index]').getByText(`真实消息_${stamp}`, { exact: true })).toHaveCount(1);

    const bytes = Buffer.from(`真实文件内容_${stamp}`);
    const mergedResponse = page.waitForResponse(response => response.url().endsWith('/file/merge_chunk'));
    await page.locator('input[type=file]').last().setInputFiles({ name: 'real-chat.txt', mimeType: 'text/plain', buffer: bytes });
    const merged = await mergedResponse;
    expect(merged.ok()).toBeTruthy();
    const filePath = (await merged.json()).data.filePath;
    await expect.poll(async () => {
      const response = await api.get('message/search', { headers: { Authorization: `Bearer ${b.token}` }, params: { room, type: 'private', mediaType: 'file' } });
      expect(response.ok()).toBeTruthy();
      return (await response.json()).data.messages.filter((message: { content: string }) => message.content === filePath).length;
    }).toBe(1);
    const download = await api.get(`http://127.0.0.1:3199${filePath}`, { headers: { Authorization: `Bearer ${b.token}` } });
    expect(download.ok()).toBeTruthy();
    expect(createHash('sha256').update(await download.body()).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    const forbidden = await api.get(`http://127.0.0.1:3199${filePath}`, { headers: { Authorization: `Bearer ${outsider.token}` } });
    expect(forbidden.status()).toBe(404);

    // Close the receiver's real transport, send while disconnected, then recover via UI.
    await peer.goto('about:blank');
    await input.fill(`离线消息_${stamp}`);
    await input.press('Enter');
    await expect.poll(async () => {
      const response = await api.get('message/search', { headers: { Authorization: `Bearer ${a.token}` }, params: { room, type: 'private', query: `离线消息_${stamp}` } });
      return (await response.json()).data.messages.length;
    }).toBe(1);
    await peer.goto('http://127.0.0.1:5199/');
    await peer.locator(`[id="chatList_${room}"]`).click();
    await expect(peer.locator('[data-message-index]').getByText(`离线消息_${stamp}`, { exact: true })).toHaveCount(1);
    await peer.reload();
    await peer.locator(`[id="chatList_${room}"]`).click();
    await expect(peer.locator('[data-message-index]').getByText(`离线消息_${stamp}`, { exact: true })).toHaveCount(1);
  } finally {
    await peerContext.close();
    await api.dispose();
  }
});
