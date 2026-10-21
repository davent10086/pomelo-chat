if (!process.env.TEST_TMPDIR || !process.env.TEST_ARTIFACT_DIR) throw new Error('Run desktop checks through the root test entrypoint');
// Real Electron windows + isolated HTTP mocks. No database or model credentials needed.
const { _electron: electron, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const url = 'http://127.0.0.1:5188';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const user = id => ({ id, username: `desktop-test-${id}`, name: '原型测试', avatar: '/ai-assistant.svg', phone: '', signature: '', created_at: '' });
let app, vite;
fs.mkdirSync(process.env.TEST_TMPDIR, { recursive: true });
const profile = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR, 'desktop-smoke-'));

async function login(main, id = 1) {
  await main.evaluate(({ id, user }) => {
    sessionStorage.setItem('pomelo-chat.authToken', JSON.stringify(`desktop-test-token-${id}`));
    sessionStorage.setItem('pomelo-chat.userInfo', JSON.stringify(user));
    window.dispatchEvent(new Event('pomelo-session-changed'));
  }, { id, user: user(id) });
}
async function run() {
  vite = spawn(process.execPath, [require.resolve('../../client/node_modules/vite/bin/vite.js'), 'client', '--host', '127.0.0.1', '--port', '5188', '--strictPort'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, POMELO_DESKTOP_DEV: '1', VITE_API_BASE: `${url}/api/chat/v1`, VITE_WS_BASE: `${url.replace('http', 'ws')}/api/chat/v1`, VITE_SERVER_URL: url }
  });
  let viteOutput = '';
  vite.stdout.on('data', chunk => { viteOutput += chunk; });
  vite.stderr.on('data', chunk => { viteOutput += chunk; });
  for (let i = 0; i < 150; i++) {
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${viteOutput}`);
    try { if ((await fetch(url)).ok) break; } catch {}
    if (i === 149) throw new Error('Vite readiness timeout');
    await pause(200);
  }
  const env = { ...process.env, POMELO_DESKTOP_URL: url, POMELO_DESKTOP_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..')], env, timeout: 30000 });
  await expect.poll(() => app.windows().length).toBe(2);
  const windows = app.windows();
  await Promise.all(windows.map(page => page.waitForLoadState('domcontentloaded')));
  const assistant = windows.find(page => page.url().includes('/desktop-assistant'));
  const main = windows.find(page => page !== assistant);
  assert(assistant && main, 'both windows exist');
  assistant.setDefaultTimeout(10000);
  const errors = [];
  assistant.on('pageerror', error => errors.push(error.message));
  await expect.poll(() => main.url()).toContain('/login');
  await login(main);
  await expect(assistant.getByRole('button', { name: '展开 AI 助手' })).toBeVisible();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/desktop-assistant')).isVisible())).toBe(true);
  await assistant.bringToFront();
  const artifacts = process.env.TEST_ARTIFACT_DIR; fs.mkdirSync(artifacts, { recursive: true });
  await assistant.screenshot({ path: path.join(artifacts, 'assistant-ball.png') });
  await assistant.getByRole('button', { name: '展开 AI 助手' }).click({ force: true });
  await expect(assistant.locator('.assistant-root')).toHaveAttribute('data-phase', 'expanded');
  const checkDock = () => app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const main = windows.find(w => !w.webContents.getURL().includes('/desktop-assistant')).getBounds();
    const assistant = windows.find(w => w.webContents.getURL().includes('/desktop-assistant')).getBounds();
    return { follows: assistant.x === main.x + main.width && assistant.y === main.y, sameHeight: assistant.height === main.height, width: assistant.width };
  });
  assert.deepEqual(await checkDock(), { follows: true, sameHeight: true, width: 360 });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('/desktop-assistant'));
    const b = w.getBounds(); w.setBounds({ ...b, x: b.x + 20, y: b.y + 12, height: b.height - 20 }); });
  await expect.poll(checkDock).toEqual({ follows: true, sameHeight: true, width: 360 });
  await main.evaluate(() => window.pomeloDesktop.windowControl('maximize'));
  await expect.poll(checkDock).toEqual({ follows: true, sameHeight: true, width: 360 });
  await assistant.getByRole('button', { name: '折叠 AI 助手' }).click();
  await expect(assistant.locator('.assistant-root')).toHaveAttribute('data-phase', 'collapsed');
  assert.equal(await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('/desktop-assistant'));
    return w.getBounds().width === screen.getDisplayMatching(w.getBounds()).workArea.width - 40;
  }), true, 'maximized main reclaims space when assistant folds');
  await assistant.getByRole('button', { name: '展开 AI 助手' }).click();
  await expect(assistant.locator('.assistant-root')).toHaveAttribute('data-phase', 'expanded');
  await main.evaluate(() => window.pomeloDesktop.windowControl('maximize'));
  assert.equal(await assistant.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)');
  await assistant.screenshot({ path: path.join(artifacts, 'assistant-welcome.png') });

  // Render the real chat UI with isolated data for layout verification.
  const mockChats = [
    { receiver_id: 2, receiver_username: 'colleague', name: '林晓', room: 'private_1_2', lastMessage: '下午一起确认桌面版的布局。', avatar: '/ai-assistant.svg', type: 'text', unreadCount: 2, updated_at: new Date().toISOString() },
    { receiver_id: 7, name: '产品设计讨论群', room: 'group_7', lastMessage: '新版界面已更新', avatar: '/ai-assistant.svg', type: 'text', unreadCount: 0, updated_at: new Date().toISOString() }
  ];
  await main.route('**/api/chat/v1/**', route => route.fulfill({ json: { code: 200, data: route.request().url().includes('chat_list') ? mockChats : /friend|group/.test(route.request().url()) ? [] : { messages: [], hasMore: false, steps: [] } } }));
  await main.routeWebSocket('**/message/connect_chat?**', ws => {
    setTimeout(() => ws.send(JSON.stringify({ name: 'history', hasMore: false, messages: [
      { id: 1, sender_id: 2, receiver_id: 1, room: 'private_1_2', type: 'text', content: '新的桌面布局看起来怎么样？', avatar: '/ai-assistant.svg', created_at: new Date().toISOString(), room_seq: 1 },
      { id: 2, sender_id: 1, receiver_id: 2, room: 'private_1_2', type: 'text', content: '聊天在左边，AI 助手贴在右侧，可以随时折叠。', avatar: '/ai-assistant.svg', created_at: new Date().toISOString(), room_seq: 2 }
    ] })), 100);
  });
  await main.routeWebSocket('**/notification/**', () => {});
  await main.goto(url);
  await main.locator('[id="chatList_private_1_2"]').click();
  await expect(main.getByLabel('消息输入框')).toBeVisible();
  await expect(main.getByText('新的桌面布局看起来怎么样？', { exact: true })).toBeVisible();
  await main.screenshot({ path: path.join(artifacts, 'main-wechat-layout.png') });
  const viewport = await main.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await require('./preview.cjs')(artifacts, viewport.width, viewport.height);
  const composer = await main.getByLabel('消息输入框').boundingBox();
  const sendButton = await main.getByRole('button', { name: /^发\s*送$/ }).boundingBox();
  assert(composer && sendButton && composer.y + composer.height <= sendButton.y + 2, 'composer leaves room for bottom toolbar');
  await assistant.getByLabel('关联当前聊天', { exact: true }).check();
  await expect(assistant.getByText('当前：林晓')).toBeVisible();
  await main.locator('[id="chatList_group_7"]').click();
  await expect(assistant.getByText('当前：产品设计讨论群')).toBeVisible();
  await main.getByRole('button', { name: '通讯录', exact: true }).click();
  await expect(assistant.getByText('请在主窗口选择聊天')).toBeVisible();
  await main.getByRole('button', { name: '聊天', exact: true }).click();
  await assistant.getByLabel('关联当前聊天', { exact: true }).uncheck();
  await main.goto(`${url}/login`);

  // Role checks run against actual preload/IPC, not only protocol unit mocks.
  assert.equal(await assistant.evaluate(async () => {
    try { await window.pomeloDesktop.publishAuth(null); return false; } catch { return true; }
  }), true);
  assert.equal(await assistant.evaluate(async () => {
    try { await window.pomeloDesktop.windowControl('close'); return false; } catch { return true; }
  }), true);
  const chatA = { room: 'private_1_2', type: 'private', receiverId: 2, name: '同事 A' };
  const chatB = { room: 'group_7', type: 'group', receiverId: 7, name: '项目讨论群' };
  await main.evaluate(chat => window.pomeloDesktop.publishChat(chat), chatA);
  await assistant.getByLabel('关联当前聊天', { exact: true }).check();
  await expect(assistant.getByText('当前：同事 A')).toBeVisible();
  const requests = [];
  let responseMode = 'success', responseDelay = 0;
  await assistant.route('**/assistant/agent/stream', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    const mode = responseMode, delay = responseDelay;
    await pause(delay);
    if (mode === '403' || mode === '401') return route.fulfill({ status: Number(mode), contentType: 'application/json', body: '{}' });
    if (mode === 'disconnect') return route.abort('failed');
    const result = { content: `回答：${body.input}`, replySuggestions: ['建议一：收到，我来跟进。'], actions: [],
      ...(mode === 'draft' ? { draftMessage: '明天下午三点开会' } : {}) };
    await route.fulfill({ contentType: 'text/event-stream', body: `event: delta\ndata: ${JSON.stringify({ delta: '正在整理', reset: false })}\n\nevent: result\ndata: ${JSON.stringify(result)}\n\n` }).catch(() => {});
  });
  responseDelay = 600;
  await assistant.getByRole('button', { name: '总结聊天', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  assert.equal(requests[0].room, chatA.room);
  assert.equal(requests[0].context.memoryEnabled, false);
  await main.evaluate(chat => window.pomeloDesktop.publishChat(chat), chatB);
  await assistant.getByRole('button', { name: '折叠 AI 助手' }).click();
  await expect(assistant.locator('.assistant-root')).toHaveAttribute('data-phase', 'collapsed');
  await expect(assistant.locator('.unread-dot')).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('/desktop-assistant')).minimize());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/desktop-assistant')).isVisible())).toBe(false);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('/desktop-assistant')).restore());
  await assistant.bringToFront();
  await assistant.getByRole('button', { name: '展开 AI 助手' }).click();
  await expect(assistant.locator('.assistant-root')).toHaveAttribute('data-phase', 'expanded');
  await expect(assistant.locator('.unread-dot')).toHaveCount(0);
  await expect(assistant.getByText('当前：项目讨论群')).toBeVisible();
  await expect(assistant.locator('.message-source').last()).toContainText('同事 A');
  responseDelay = 0;
  await assistant.getByRole('button', { name: '回复建议', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  assert.equal(requests[1].room, chatB.room);
  assert.equal(requests[1].context.currentChatType, 'group');
  assert.equal(requests[1].context.recentMessagesText, '');
  await expect(assistant.getByRole('button', { name: /建议一/ })).toHaveCount(2);

  responseMode = '403';
  await assistant.getByLabel('向 AI 助手提问').fill('失败后保留输入');
  await assistant.getByRole('button', { name: '发送提问', exact: true }).click();
  await expect(assistant.getByText('没有权限访问该会话。')).toBeVisible();
  await expect(assistant.getByLabel('向 AI 助手提问')).toHaveValue('失败后保留输入');
  responseMode = 'success'; responseDelay = 1000;
  await assistant.getByRole('button', { name: '发送提问', exact: true }).click();
  await expect.poll(() => requests.length).toBe(4);
  await assistant.getByRole('button', { name: '停止', exact: true }).click();
  await expect(assistant.locator('.assistant-message').last()).toContainText('已停止生成');
  await expect(assistant.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  responseMode = 'disconnect'; responseDelay = 0;
  await assistant.getByLabel('向 AI 助手提问').fill('模拟断线');
  await assistant.getByRole('button', { name: '发送提问', exact: true }).click();
  await expect.poll(() => requests.length).toBe(5);
  await expect(assistant.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await expect(assistant.locator('.assistant-message').last()).toContainText('Failed to fetch');
  await expect(assistant.getByLabel('向 AI 助手提问')).toHaveValue('模拟断线');

  await assistant.emulateMedia({ reducedMotion: 'reduce' });
  await assistant.getByRole('button', { name: '折叠 AI 助手' }).click();
  await expect(assistant.locator('.assistant-root')).toHaveAttribute('data-phase', 'collapsed');
  assert.equal(await assistant.locator('.assistant-ball').evaluate(element => getComputedStyle(element).animationName), 'none');
  const beforeDrag = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/desktop-assistant')).getBounds());
  await assistant.mouse.move(32, 32); await assistant.mouse.down(); await assistant.mouse.move(20, 20, { steps: 3 }); await assistant.mouse.up();
  await expect(assistant.locator('.assistant-root')).toHaveAttribute('data-phase', 'collapsed');
  await expect.poll(async () => {
    const after = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/desktop-assistant')).getBounds());
    return after.x !== beforeDrag.x || after.y !== beforeDrag.y;
  }, { message: 'native drag moves the attached window group without opening it' }).toBe(true);
  // Rapid latest-intent reversal from renderer, including a pending native resize.
  await assistant.getByRole('button', { name: '展开 AI 助手' }).click();
  await assistant.getByRole('button', { name: '折叠 AI 助手' }).evaluate(button => { button.click(); button.click(); });
  await expect(assistant.locator('.assistant-root')).toHaveAttribute('data-phase', 'expanded');

  // The independent desktop renderer must expose actual recipient review controls, too.
  let confirmedMessages = 0;
  await assistant.route('**/message/chat_list', route => route.fulfill({ json: { code: 200, data: mockChats } }));
  await assistant.route('**/actions/message-draft', route => {
    assert.deepEqual(route.request().postDataJSON(), { room: 'private_1_2', chatType: 'private', content: '明天下午三点开会' });
    return route.fulfill({ json: { code: 200, data: { action: {
      type: 'send_message', requiresConfirmation: true, confirmationId: 'desktop-send-review',
      payload: { room: 'private_1_2', chatType: 'private', name: '林晓', username: 'colleague', receiverId: 2, content: '明天下午三点开会' }
    } } } });
  });
  await assistant.route('**/actions/confirm', route => {
    assert.equal(route.request().postDataJSON().confirmationId, 'desktop-send-review');
    confirmedMessages++;
    return route.fulfill({ json: { code: 200, data: { type: 'send_message', confirmationId: 'desktop-send-review', status: 'completed' } } });
  });
  responseMode = 'draft'; responseDelay = 0;
  await assistant.getByLabel('向 AI 助手提问').fill('帮我代写一条开会通知');
  await assistant.getByRole('button', { name: '发送提问', exact: true }).click();
  const sendCard = assistant.getByRole('region', { name: '草稿发送', exact: true });
  await expect(sendCard).toBeVisible();
  await expect(sendCard.getByRole('button', { name: '核对发送信息' })).toBeDisabled();
  await sendCard.getByLabel('选择消息收件人').selectOption('private_1_2');
  await sendCard.getByRole('button', { name: '核对发送信息' }).click();
  await expect(sendCard.getByLabel('发送确认信息')).toContainText('colleague');
  assert.equal(confirmedMessages, 0);
  await sendCard.getByRole('button', { name: '确认发送', exact: true }).click();
  await expect(sendCard.getByText('已完成', { exact: true })).toBeVisible();
  assert.equal(confirmedMessages, 1);
  await assistant.screenshot({ path: path.join(artifacts, 'assistant-panel.png') });
  await login(main, 2);
  await expect(assistant.locator('.assistant-root')).toHaveAttribute('data-phase', 'collapsed');
  await assistant.getByRole('button', { name: '展开 AI 助手' }).click();
  await expect(assistant.locator('.assistant-message')).toHaveCount(0);
  responseMode = '401'; responseDelay = 0;
  await assistant.getByLabel('向 AI 助手提问').fill('验证登录失效');
  await assistant.getByRole('button', { name: '发送提问', exact: true }).click();
  await expect(assistant.locator('.assistant-root')).toHaveCount(0);
  await expect.poll(async () => {
    try { return await main.evaluate(() => sessionStorage.getItem('pomelo-chat.authToken')); }
    catch { return 'navigating'; }
  }).toBe(null);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/desktop-assistant')).isVisible()), false);
  await login(main, 3);
  await expect(assistant.getByRole('button', { name: '展开 AI 助手' })).toBeVisible();
  assert.deepEqual(errors, []);
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('/desktop-assistant')).close()).catch(() => {});
  await Promise.race([exited, pause(5000).then(() => { throw new Error('App did not exit with main window'); })]);
  app = undefined;
  console.log('[desktop-smoke] login, IPC, animation, context isolation, streaming, cancellation, 401 and exit passed');
  await require('./launcher-smoke.cjs')(profile);
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close().catch(() => {});
  if (vite && vite.exitCode === null) {
    const exited = new Promise(resolve => vite.once('exit', resolve));
    vite.kill(); await Promise.race([exited, pause(3000)]);
  }
  if (path.dirname(profile) !== process.env.TEST_TMPDIR || !path.basename(profile).startsWith('desktop-smoke-')) throw new Error('Unsafe smoke cleanup');
  fs.rmSync(profile, { recursive: true, force: true });
});
