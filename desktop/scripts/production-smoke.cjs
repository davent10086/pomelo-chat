// Runs the packaged executable against isolated real MySQL/Redis and the real backend.
const { _electron: electron, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
if (!process.env.DATABASE_URL_TEST || !process.env.REDIS_URL_TEST || !process.env.UPLOAD_ROOT)
  throw new Error('Use pnpm test:desktop:production to create isolated service targets');
const executable = path.join(root, 'release/win-unpacked/Pomelo Chat.exe');
if (!fs.existsSync(executable)) throw new Error('Build the Windows app first: pnpm build:desktop');
const profileRoot = fs.mkdtempSync(path.join(root, 'tmp/tests/desktop-profile-'));
const artifacts = path.join(root, 'test-results/desktop-production');
fs.mkdirSync(artifacts, { recursive: true });
const apps = new Set();
let backend, backendLog = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function launch(profile) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], env, timeout: 30000 });
  apps.add(app);
  await expect.poll(() => app.windows().filter(page => !page.url().includes('/desktop-assistant')).length).toBe(1);
  const page = app.windows().find(page => !page.url().includes('/desktop-assistant'));
  page.setDefaultTimeout(15000);
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}
async function close(app) { apps.delete(app); await app.close(); }
async function configure(instance, address) {
  await instance.page.getByLabel('服务器地址', { exact: true }).fill(address);
  await instance.page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(instance.page.getByText('连接成功，可以保存并连接。')).toBeVisible();
  await instance.page.screenshot({ path: path.join(artifacts, 'server-tested.png') });
  await instance.page.getByRole('button', { name: /保存并连接/ }).click();
  await expect.poll(() => instance.app.windows().some(page => page !== instance.page && page.url().startsWith('pomelo://app') && !page.url().includes('/desktop-assistant'))).toBe(true);
  instance.page = instance.app.windows().find(page => page !== instance.page && !page.url().includes('/desktop-assistant'));
  instance.page.setDefaultTimeout(15000);
  await expect(instance.page.getByPlaceholder('请输入用户名')).toBeVisible();
}
async function login(instance, user) {
  await instance.page.getByPlaceholder('请输入用户名').fill(user.username);
  await instance.page.getByPlaceholder('请输入密码').fill(user.password);
  await instance.page.getByLabel('记住登录', { exact: true }).check();
  await instance.page.locator('button[type=submit]').click();
  await expect(instance.page.getByRole('button', { name: '聊天', exact: true })).toBeVisible();
}
async function run() {
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  backend = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', 'src/index.ts'], {
    cwd: path.join(root, 'server'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), REDIS_URL: process.env.REDIS_URL_TEST,
      REDIS_KEY_PREFIX: process.env.TEST_REDIS_KEY_PREFIX, JWT_SECRET: 'desktop-isolated-secret',
      CORS_ORIGINS: 'pomelo://app', AI_API_KEY: '', DASHSCOPE_API_KEY: '', DEEPSEEK_API_KEY: '', REQUEST_LOGS: 'false' }
  });
  for (const stream of [backend.stdout, backend.stderr]) stream.on('data', chunk => { backendLog += chunk.toString(); });
  for (let i = 0; i < 150; i++) {
    if (backend.exitCode !== null) throw new Error(`Backend exited: ${backendLog}`);
    try { if ((await fetch(`${base}/api/chat/v1/health`)).ok) break; } catch { /* Starting. */ }
    if (i === 149) throw new Error(`Backend startup timed out: ${backendLog}`);
    await pause(200);
  }
  async function api(endpoint, data, token) {
    const response = await fetch(`${base}/api/chat/v1/${endpoint}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    const result = await response.json(); assert.equal(result.code, 200, `${endpoint}: ${JSON.stringify(result)}`); return result.data;
  }
  const users = [];
  for (let i = 1; i <= 2; i++) {
    const user = { username: `desktop_${Date.now()}_${i}`, password: 'Desktop-pass-123!', phone: `139${String(Date.now()).slice(-7)}${i}` };
    await api('auth/register', { ...user, avatar: '' });
    const registered = await api('auth/login', { username: user.username, password: user.password });
    users.push({ ...user, ...registered, id: registered.info.id });
  }
  // Reuse the public contact API, exactly as the web integration tests do.
  await api('friend/add_friend', { id: users[1].id, username: users[1].username }, users[0].token);
  const chats = await api('message/chat_list', undefined, users[0].token);
  const room = chats.find(chat => Number(chat.receiver_id) === users[1].id)?.room;
  assert(room, 'friend API creates a private conversation');
  const profileA = path.join(profileRoot, 'a'), profileB = path.join(profileRoot, 'b');
  const a = await launch(profileA), b = await launch(profileB);
  await a.page.screenshot({ path: path.join(artifacts, 'first-launch.png') });
  await configure(a, base); await configure(b, base);
  assert.equal(await a.app.evaluate(({ app }) => app.isPackaged), true);
  assert(a.page.url().startsWith('pomelo://app/'));
  await login(a, users[0]); await login(b, users[1]);
  const errors = []; a.page.on('pageerror', error => errors.push(error.message));
  await a.page.locator(`[id="chatList_${room}"]`).click();
  await b.page.locator(`[id="chatList_${room}"]`).click();
  const content = `安装版消息_${Date.now()}`;
  await a.page.getByLabel('消息输入框').fill(content); await a.page.getByLabel('消息输入框').press('Enter');
  await expect(b.page.locator('[data-message-index]').getByText(content, { exact: true })).toHaveCount(1);
  const bytes = Buffer.from('packaged Worker upload verification');
  const merging = a.page.waitForResponse(response => response.url().endsWith('/file/merge_chunk'));
  const dropped = await a.page.evaluateHandle(content => {
    const data = new DataTransfer(); data.items.add(new File([content], 'desktop.txt', { type: 'text/plain' })); return data;
  }, bytes.toString());
  const dropArea = a.page.getByRole('region', { name: '聊天区域', exact: true });
  await dropArea.dispatchEvent('dragenter', { dataTransfer: dropped });
  await expect(a.page.getByText('松开即可上传并发送文件')).toBeVisible();
  await dropArea.dispatchEvent('drop', { dataTransfer: dropped });
  await dropped.dispose();
  const merged = await merging; assert(merged.ok()); const filePath = (await merged.json()).data.filePath;
  const peerToken = await b.page.evaluate(() => JSON.parse(sessionStorage.getItem('pomelo-chat.authToken')));
  await expect.poll(async () => {
    const response = await fetch(`${base}${filePath}`, { headers: { Authorization: `Bearer ${peerToken}` } }); return response.status;
  }).toBe(200);
  const download = await b.page.evaluate(async filePath => {
    const token = JSON.parse(sessionStorage.getItem('pomelo-chat.authToken'));
    const response = await fetch(`${window.pomeloDesktop.getRuntime().serverURL}${filePath}`, { headers: { Authorization: `Bearer ${token}` } });
    return response.text();
  }, filePath);
  assert.equal(download, bytes.toString());
  const downloadPath = path.join(profileRoot, 'downloaded.txt');
  await b.app.evaluate(({ BrowserWindow }, destination) => {
    const main = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('/desktop-assistant'));
    globalThis.__pomeloDownloadName = new Promise(resolve => {
      main.webContents.session.once('will-download', (_event, item) => {
        item.setSavePath(destination);
        setImmediate(() => resolve(item.getSaveDialogOptions().defaultPath));
      });
    });
  }, downloadPath);
  await b.page.getByRole('button', { name: /^下载文件/ }).click();
  await expect.poll(() => fs.existsSync(downloadPath) ? fs.readFileSync(downloadPath).toString() : '').toBe(bytes.toString());
  assert.equal(path.basename(await b.app.evaluate(async () => await globalThis.__pomeloDownloadName)), 'desktop.txt');
  const token = await a.page.evaluate(() => JSON.parse(sessionStorage.getItem('pomelo-chat.authToken')));
  const assistant = a.app.windows().find(page => page.url().includes('/desktop-assistant'));
  await assistant.route('**/assistant/agent/stream', route => route.fulfill({ contentType: 'text/event-stream', body:
    `event: result\ndata: ${JSON.stringify({ content: '草稿已准备，请选择收件人并核对。', draftMessage: '确认发送的安装版草稿', actions: [], replySuggestions: [] })}\n\n` }));
  await assistant.getByRole('button', { name: '展开 AI 助手' }).click();
  await assistant.getByLabel('向 AI 助手提问').fill('帮我准备一条消息');
  await assistant.getByRole('button', { name: '发送提问', exact: true }).click();
  const card = assistant.getByRole('region', { name: '草稿发送', exact: true });
  await card.getByLabel('选择消息收件人').selectOption(room);
  await card.getByRole('button', { name: '核对发送信息' }).click();
  await expect(card.getByLabel('发送确认信息')).toContainText(users[1].username);
  await expect(b.page.locator('[data-message-index]').getByText('确认发送的安装版草稿', { exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: '确认发送', exact: true }).click();
  await expect(card.getByText('已完成', { exact: true })).toBeVisible();
  await expect(b.page.locator('[data-message-index]').getByText('确认发送的安装版草稿', { exact: true })).toHaveCount(1);
  await a.page.getByLabel('消息输入框').fill('重启保留的草稿');
  const pendingId = `desktop-pending-${Date.now()}`;
  // Seed the real store with a retained user-confirmed send that has not yet obtained an ACK.
  // Use the same IndexedDB schema as the client, then let the real queue retry after restart.
  await a.page.evaluate(async ({ room, pendingId, receiverId }) => {
    const user = JSON.parse(sessionStorage.getItem('pomelo-chat.userInfo'));
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pomelo-pending-messages', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('messages', { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      tx.objectStore('messages').put({ key: JSON.stringify([user.id, room, pendingId]), userId: user.id, room, chatType: 'private',
        createdAt: Date.now(), owner: 'previous-process', leaseUntil: 0,
        message: { clientMsgId: pendingId, sender_id: user.id, receiver_id: receiverId, type: 'text', content: '安装版待发恢复', avatar: '' } });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { room, pendingId, receiverId: users[1].id });
  await a.page.screenshot({ path: path.join(artifacts, 'chat.png') });
  await close(a.app);
  const restarted = await launch(profileA);
  await expect(restarted.page.getByRole('button', { name: '聊天', exact: true })).toBeVisible();
  await restarted.page.locator(`[id="chatList_${room}"]`).click();
  await expect(restarted.page.getByLabel('消息输入框')).toHaveText('重启保留的草稿');
  await expect(b.page.locator('[data-message-index]').getByText('安装版待发恢复', { exact: true })).toHaveCount(1);
  const files = fs.readdirSync(profileA).filter(name => name.startsWith('session-'));
  assert.equal(files.length, 1); assert(!fs.readFileSync(path.join(profileA, files[0]), 'utf8').includes(token));
  // A receiver process is closed while a message is persisted; restart must recover it exactly once.
  await close(b.app);
  await restarted.page.getByLabel('消息输入框').fill('安装版离线恢复'); await restarted.page.getByLabel('消息输入框').press('Enter');
  await expect(restarted.page.locator('[data-message-index]').filter({ hasText: '安装版离线恢复' }).getByRole('status', { name: '已发送', exact: true })).toBeVisible();
  const recovered = await launch(profileB);
  await recovered.page.locator(`[id="chatList_${room}"]`).click();
  await expect(recovered.page.locator('[data-message-index]').getByText('安装版离线恢复', { exact: true })).toHaveCount(1);
  // Explicit logout clears both the encrypted credentials and this account's drafts/queue.
  await restarted.page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(restarted.page.getByPlaceholder('请输入用户名')).toBeVisible();
  assert.equal(fs.readdirSync(profileA).filter(name => name.startsWith('session-')).length, 0);
  await close(restarted.app);
  const loggedOut = await launch(profileA);
  await expect(loggedOut.page.getByPlaceholder('请输入用户名')).toBeVisible();
  await loggedOut.page.getByRole('button', { name: '服务器设置', exact: true }).click();
  await configure(loggedOut, base.replace('127.0.0.1', 'localhost'));
  assert.equal(await loggedOut.page.evaluate(() => localStorage.getItem('pomelo-desktop.remember')), null);
  assert.deepEqual(errors, []);
  console.log('[desktop-production] packaged local startup, server setup, real login/message/upload/download, confirmed draft, encrypted restart, persistent draft, offline recovery and logout passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const app of apps) await app.close().catch(() => {});
  if (backend && backend.exitCode === null) {
    const stopped = once(backend, 'exit'); backend.kill(); await Promise.race([stopped, pause(5000)]);
  }
  fs.writeFileSync(path.join(artifacts, 'backend.log'), backendLog);
  const expectedParent = path.join(root, 'tmp/tests');
  if (path.dirname(profileRoot) !== expectedParent || !path.basename(profileRoot).startsWith('desktop-profile-')) throw new Error('Unsafe profile cleanup');
  fs.rmSync(profileRoot, { recursive: true, force: true });
});
