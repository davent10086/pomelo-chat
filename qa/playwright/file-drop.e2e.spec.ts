import { test, expect } from '@playwright/test';
import { setup, login } from './helpers/chat';

test('file drops do not send late uploads after switching rooms, reject directories and preserve text drags', async ({ page }) => {
  const { api, a, room } = await setup();
  let release!: () => void;
  try {
    await login(page, a, room);
    a.token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pomelo-chat.authToken') || '""'));
    const area = page.getByRole('region', { name: '聊天区域', exact: true });
    const text = await page.evaluateHandle(() => {
      const transfer = new DataTransfer(); transfer.setData('text/plain', '普通拖动文字'); return transfer;
    });
    await area.dispatchEvent('dragenter', { dataTransfer: text });
    await expect(page.getByText('松开即可上传并发送文件')).toHaveCount(0);
    await text.dispose();
    let uploadRequests = 0;
    page.on('request', request => { if (request.url().includes('/file/')) uploadRequests++; });
    await area.evaluate(element => {
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: {
        types: ['Files'], files: [], items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }]
      } });
      element.dispatchEvent(event);
    });
    await expect(page.getByText('暂不支持拖拽文件夹，请选择文件')).toBeVisible();
    expect(uploadRequests).toBe(0);
    const empty = await page.evaluateHandle(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File([], 'empty.txt', { type: 'text/plain' })); return transfer;
    });
    await area.dispatchEvent('drop', { dataTransfer: empty });
    await expect(page.getByText('empty.txt：文件大小需在 1B 到 100MB 之间')).toBeVisible();
    expect(uploadRequests).toBe(0); await empty.dispose();
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let merging = false;
    await page.route('**/file/merge_chunk', async route => { merging = true; await blocked; await route.continue(); });
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer(); data.items.add(new File(['late-room-upload'], 'late.txt', { type: 'text/plain' })); return data;
    });
    await area.dispatchEvent('drop', { dataTransfer: transfer });
    await expect.poll(() => merging).toBe(true);
    await area.dispatchEvent('drop', { dataTransfer: transfer });
    await expect(page.getByText('正在上传文件，请稍后再试')).toBeVisible();
    const mergeResponse = page.waitForResponse(response => response.url().endsWith('/file/merge_chunk'));
    await page.locator(`[id="chatList_ai_${a.info.id}"]`).click();
    release();
    const uploaded = (await (await mergeResponse).json()).data.filePath;
    await page.locator(`[id="chatList_${room}"]`).click();
    const history = await api.get('message/search', { headers: { Authorization: `Bearer ${a.token}` }, params: { room, type: 'private', mediaType: 'file' } });
    expect((await history.json()).data.messages.filter((item: { content: string }) => item.content === uploaded)).toHaveLength(0);
    await expect(page.locator('[data-message-index]').getByRole('button', { name: /^下载文件/ })).toHaveCount(0);
    await transfer.dispose();
  } finally { release?.(); await api.dispose(); }
});
