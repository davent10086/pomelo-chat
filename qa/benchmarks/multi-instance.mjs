import { startChatBackend } from './chat-backend.mjs';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import path from 'node:path';
const require = createRequire(path.resolve('server/package.json')), WS = require('ws');
const { chromium, expect: baseExpect } = createRequire(path.resolve('package.json'))('@playwright/test');
const expect = baseExpect.configure({ timeout: 20000 });
const output = path.resolve('test-results', `multi-instance-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
// Functional checks use a large explicit budget, separate from measured default-protection trials.
for (const key of ['USER', 'PRIVATE', 'GROUP', 'GLOBAL']) for (const suffix of ['RATE', 'BURST']) process.env[`MESSAGE_${key}_${suffix}`] = '10000';
process.env.API_RATE_LIMIT_MAX = '1000000';
process.env.BENCH_DIAGNOSTIC_PRELOAD = path.resolve('qa/benchmarks/probes/fanout-fault.cjs');
process.env.CORS_ORIGINS = 'http://127.0.0.1:5291,http://127.0.0.1:5292';
const report = { started: new Date().toISOString(), checks: [], scope: 'Two independent backend processes on one host, shared isolated MySQL/Redis/upload directory. Functional budgets raised; not a capacity benchmark.' };
const sockets = [], frontends = [];
let backend, browser;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check, label, ms = 15000) {
  const end = performance.now() + ms;
  while (!await check()) { if (performance.now() > end) throw new Error(label); await sleep(10); }
}
async function check(name, action) {
  const start = performance.now();
  try { const details = await action(); report.checks.push({ name, passed: true, ms: performance.now() - start, ...details }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, passed: false, error: error.message }); throw error; }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
async function api(index, route, auth, body) {
  const response = await fetch(`${backend.instances[index].base}/api/chat/v1/${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000)
  });
  const json = await response.json(); assert.equal(json.code, 200, `${route}: ${response.status}/${json.code}`); return json.data;
}
async function connect(index, auth, room) {
  const peer = { index, auth, room, frames: [], seen: new Map(), pending: new Map(), last: 0, duplicates: 0, orderErrors: 0 };
  const ws = new WS(`${backend.instances[index].base.replace('http:', 'ws:')}/api/chat/v1/message/connect_chat?room=${room}&id=${auth.info.id}&type=private`, ['pomelo-token', auth.token]);
  peer.ws = ws; sockets.push(peer);
  ws.on('error', () => {});
  ws.on('message', raw => {
    const frame = JSON.parse(raw); peer.frames.push(frame);
    if (frame.receipt && ws.readyState === 1) ws.send(JSON.stringify({ name: 'delivery_ack', receipt: frame.receipt }));
    if (frame.name === 'ack' || frame.name === 'error') peer.pending.get(frame.client_msg_id)?.(frame);
    else if (frame.id) {
      if (peer.seen.has(frame.id)) peer.duplicates++;
      else { if (frame.room_seq <= peer.last) peer.orderErrors++; peer.last = frame.room_seq; peer.seen.set(frame.id, frame); }
    }
  });
  await wait(() => peer.frames.some(frame => frame.name === 'history'), 'Initial socket history missing');
  return peer;
}
async function send(peer, content, id = `multi-${randomUUID()}`) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { peer.pending.delete(id); reject(new Error('ACK timeout')); }, 15000);
    peer.pending.set(id, frame => { clearTimeout(timer); peer.pending.delete(id); frame.name === 'error' ? reject(new Error(frame.message || frame.code)) : resolve(frame); });
    peer.ws.send(JSON.stringify({ content, type: 'text', clientMsgId: id }));
  });
}
async function closePeer(peer) { if (peer.ws.readyState < 2) peer.ws.terminate(); await wait(() => peer.ws.readyState === 3, 'Socket did not close'); }
async function history(index, auth, room, cursor = 0) {
  const messages = []; let pages = 0;
  while (true) {
    const batch = await api(index, `message/history?room=${room}&type=private&afterSeq=${cursor}&limit=80`, auth);
    pages++; messages.push(...batch.messages);
    if (!batch.messages.length || !batch.hasMore) return { messages, pages, peerReadSeq: batch.peerReadSeq };
    cursor = batch.messages.at(-1).room_seq;
  }
}
async function startFrontend(index) {
  const port = 5291 + index;
  const probe = createServer(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); }); await new Promise(resolve => probe.close(resolve));
  const base = backend.instances[index].base, url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve('client/node_modules/vite/bin/vite.js'), 'client', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, POMELO_DESKTOP_DEV: '1', VITE_API_BASE: `${base}/api/chat/v1`, VITE_WS_BASE: `${base.replace('http:', 'ws:')}/api/chat/v1`, VITE_SERVER_URL: base }
  });
  frontends.push(child);
  let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  await wait(async () => { if (child.exitCode !== null) throw new Error(log); try { return (await fetch(url)).ok; } catch { return false; } }, 'Vite startup timeout', 60000);
  return url;
}
try {
  backend = await startChatBackend(process.cwd(), { instances: 2 });
  report.instances = backend.instances.map(({ pid, port }) => ({ pid, port })); report.versions = backend.versions;
  assert.notEqual(report.instances[0].pid, report.instances[1].pid);
  const [fixture, browserFixture] = await backend.createIndependentPeers(2, true), room = fixture.room.room;
  let a = await connect(0, fixture.auth, room), b = await connect(1, fixture.receiverAuth, room);
  await check('cross-instance bidirectional broadcast and ACK', async () => {
    const samples = [];
    for (let i = 0; i < 20; i++) {
      const source = i % 2 ? b : a, target = i % 2 ? a : b, start = performance.now();
      const ack = await send(source, `bidirectional-${i}`); assert(ack.id && ack.room_seq);
      await wait(() => target.seen.has(ack.id), 'Cross-instance broadcast missing'); samples.push(performance.now() - start);
    }
    assert.equal(a.orderErrors + b.orderErrors, 0);
    return { messages: 20, maximumAckAndReceiveMs: Math.max(...samples) };
  });
  await check('concurrent idempotent writes on different instances', async () => {
    const second = await connect(1, fixture.auth, room), id = `multi-idempotent-${randomUUID()}`;
    const replies = [];
    for (let i = 0; i < 6; i++) replies.push(...await Promise.all([send(a, 'exact duplicate payload', id), send(second, 'exact duplicate payload', id)]));
    assert.equal(new Set(replies.map(row => row.id)).size, 1); assert.equal(new Set(replies.map(row => row.room_seq)).size, 1);
    const stored = (await history(1, fixture.auth, room)).messages.filter(row => row.client_msg_id === id); assert.equal(stored.length, 1);
    await assert.rejects(send(second, 'conflicting content', id)); await closePeer(second);
    return { attempts: 12, simultaneousWriters: 2, persistedRows: stored.length, conflictRejected: true };
  });
  await check('lost ACK replay after connecting to the other instance', async () => {
    const id = `multi-lost-${randomUUID()}`;
    // Deliberately do not install an ACK resolver; rely only on peer delivery before reconnecting.
    a.ws.send(JSON.stringify({ content: 'lost ACK retry', type: 'text', clientMsgId: id }));
    await wait(() => [...b.seen.values()].some(row => row.client_msg_id === id), 'Message was not persisted/delivered');
    const original = [...b.seen.values()].find(row => row.client_msg_id === id);
    await closePeer(a); a = await connect(1, fixture.auth, room);
    const ack = await send(a, 'lost ACK retry', id); assert.equal(ack.id, original.id); assert.equal(ack.room_seq, original.room_seq);
    return { originalId: original.id, retryId: ack.id };
  });
  await check('offline reconnect and paginated history compensation over 80 messages', async () => {
    const cursor = Math.max(...[...b.seen.values()].map(row => row.room_seq)); await closePeer(b);
    const expected = [];
    for (let i = 0; i < 125; i++) expected.push(await send(a, `offline-${i}`));
    b = await connect(0, fixture.receiverAuth, room);
    const recovered = await history(0, fixture.receiverAuth, room, cursor);
    assert.equal(recovered.messages.length, 125); assert(recovered.pages >= 2);
    assert.deepEqual(recovered.messages.map(row => row.id), expected.map(row => row.id));
    assert.equal(new Set(recovered.messages.map(row => row.id)).size, 125);
    return { recovered: 125, pages: recovered.pages };
  });
  await check('cross-instance read receipt, monotonic cursor and persisted reload', async () => {
    await closePeer(a); a = await connect(1, fixture.auth, room);
    const last = await send(a, 'read receipt last'); await wait(() => b.seen.has(last.id), 'Message not received');
    await api(0, 'message/read', fixture.receiverAuth, { room, type: 'private', roomSeq: last.room_seq });
    await wait(() => a.frames.some(row => row.name === 'read_receipt' && row.roomSeq === last.room_seq), 'Cross-instance read receipt missing');
    await api(0, 'message/read', fixture.receiverAuth, { room, type: 'private', roomSeq: 1 });
    assert.equal((await history(1, fixture.auth, room)).peerReadSeq, last.room_seq);
    await closePeer(a); a = await connect(0, fixture.auth, room);
    assert.equal(a.frames.find(row => row.name === 'history').peerReadSeq, last.room_seq);
    return { readSeq: last.room_seq, lowerCursorIgnored: true };
  });
  await closePeer(a); await closePeer(b);
  await check('room revocation blocks both backend instances without revoking login', async () => {
    const [pair] = await backend.createIndependentPeers(1, true);
    const room = pair.room.room;
    const sender = await connect(0, pair.auth, room);
    const recipients = await Promise.all([connect(0, pair.receiverAuth, room), connect(1, pair.receiverAuth, room)]);
    const before = await send(sender, 'allowed before room revocation');
    await wait(() => recipients.every(peer => peer.seen.has(before.id)), 'Normal delivery missing');
    await backend.revokeRoomAccess(pair.receiverAuth.info.id, room);
    const after = await send(sender, 'secret after room revocation');
    await wait(() => recipients.every(peer => peer.ws.readyState === 3), 'Revoked room sockets were not closed');
    assert(recipients.every(peer => !peer.seen.has(after.id)), 'Revoked recipient received content');
    await api(1, 'message/chat_list', pair.receiverAuth); // login remains valid
    const denied = await fetch(`${backend.instances[1].base}/api/chat/v1/message/history?room=${room}&type=private`, { headers: { Authorization: `Bearer ${pair.receiverAuth.token}` } });
    assert.equal(denied.status, 401);
    await closePeer(sender);
    return { localBlocked: true, remoteBlocked: true, loginStillValid: true };
  });
  await check('two browser clients use different actual backend instances', async () => {
    const fixture = browserFixture, room = fixture.room.room;
    const urls = [await startFrontend(0), await startFrontend(1)];
    browser = await chromium.launch({ headless: true });
    const contexts = [await browser.newContext(), await browser.newContext()], pages = await Promise.all(contexts.map(c => c.newPage()));
    const accounts = [fixture.auth, fixture.receiverAuth];
    const connections = [[], []];
    for (let i = 0; i < 2; i++) {
      pages[i].on('websocket', socket => connections[i].push(socket.url()));
      await pages[i].addInitScript(auth => {
        sessionStorage.setItem('pomelo-chat.authToken', JSON.stringify(auth.token)); sessionStorage.setItem('pomelo-chat.userInfo', JSON.stringify(auth.info));
      }, accounts[i]);
      await pages[i].goto(urls[i]); await pages[i].locator(`[id="chatList_${room}"]`).click();
      await expect(pages[i].getByLabel('消息输入框')).toBeVisible();
    }
    assert(connections[0].some(url => url.includes(`:${backend.instances[0].port}/`)));
    assert(connections[1].some(url => url.includes(`:${backend.instances[1].port}/`)));
    const content = `browser-cross-${randomUUID()}`;
    await pages[0].getByLabel('消息输入框').fill(content); await pages[0].getByLabel('消息输入框').press('Enter');
    await expect(pages[1].locator('[data-message-index]').getByText(content, { exact: true })).toHaveCount(1);
    await expect(pages[0].locator('[data-message-index]').filter({ hasText: content }).getByRole('status', { name: '对方已读', exact: true })).toBeVisible();
    await pages[0].reload(); await pages[0].locator(`[id="chatList_${room}"]`).click();
    await expect(pages[0].locator('[data-message-index]').filter({ hasText: content }).getByRole('status', { name: '对方已读', exact: true })).toBeVisible();
    await check('subscriber disconnect/resubscribe triggers real browser compensation', async () => {
      // Pause only the two test fanout subscriptions; Redis and other applications remain running.
      await backend.controlInstance(1, { type: 'benchmark:pause-worker' });
      await backend.controlInstance(0, { type: 'benchmark:pause-fanout' });
      await backend.controlInstance(1, { type: 'benchmark:pause-fanout' });
      const text = `pubsub-gap-${randomUUID()}`;
      await pages[0].getByLabel('消息输入框').fill(text); await pages[0].getByLabel('消息输入框').press('Enter');
      await expect(pages[0].locator('[data-message-index]').filter({ hasText: text }).getByRole('status', { name: '已发送', exact: true })).toBeVisible();
      await wait(async () => Number((await backend.auditMessages()).pendingOutbox) === 0, 'Publication did not finish');
      await expect(pages[1].locator('[data-message-index]').getByText(text, { exact: true })).toHaveCount(0);
      await backend.controlInstance(0, { type: 'benchmark:resume-fanout' });
      await backend.controlInstance(1, { type: 'benchmark:resume-fanout' });
      await backend.controlInstance(1, { type: 'benchmark:resume-worker' });
      await expect(pages[1].locator('[data-message-index]').getByText(text, { exact: true })).toHaveCount(1);
      return { resyncRecovered: true };
    });
    await check('backend process exit/restart automatically reconnects and recovers browser history', async () => {
      const oldPid = backend.instances[1].pid; await backend.stopInstance(1);
      const messages = Array.from({ length: 3 }, (_, i) => `restart-gap-${i}-${randomUUID()}`);
      for (const text of messages) {
        await pages[0].getByLabel('消息输入框').fill(text); await pages[0].getByLabel('消息输入框').press('Enter');
        await expect(pages[0].locator('[data-message-index]').filter({ hasText: text }).getByRole('status', { name: '已发送', exact: true })).toBeVisible();
      }
      await backend.restartInstance(1); assert.notEqual(backend.instances[1].pid, oldPid);
      for (const text of messages) await expect(pages[1].locator('[data-message-index]').getByText(text, { exact: true })).toHaveCount(1);
      await pages[1].screenshot({ path: path.join(output, 'receiver-after-restart.png') });
      return { oldPid, newPid: backend.instances[1].pid, recovered: messages.length };
    });
    return { browsers: 2, httpResponseStubs: false, websocketInterception: false };
  });
  await wait(async () => Number((await backend.auditMessages()).pendingOutbox) === 0, 'Outbox not drained');
  report.audit = await backend.auditMessages(); assert.equal(report.audit.sequenceErrors.length, 0); assert.equal(report.audit.statisticsErrors.length, 0);
  report.completed = true;
} catch (error) { report.completed = false; report.error = error.stack; console.error(error); process.exitCode = 1; }
finally {
  if (browser) await browser.close();
  for (const peer of sockets) peer.ws.terminate();
  for (const child of frontends) if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  if (backend) {
    for (const instance of backend.instances) await writeFile(path.join(output, `backend-${instance.index}.log`), instance.logs);
    await backend.close();
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(`Report: ${output}`);
}
