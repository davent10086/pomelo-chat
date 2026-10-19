/** Real cross-language matrix. Run only through run-isolated-tests.js realtime. */
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:net');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const WS = require('ws');
if (!process.env.DATABASE_URL_TEST || !process.env.REDIS_URL_TEST || !process.env.TEST_REDIS_KEY_PREFIX)
  throw new Error('Use the isolated realtime runner');
const root = path.resolve(__dirname, '../..'), goRoot = path.join(root, 'services/realtime');
const binary = path.join(root, 'tmp', `pomelo-realtime-test-${process.pid}${process.platform === 'win32' ? '.exe' : ''}`);
Object.assign(process.env, {
  NODE_ENV: 'test', REDIS_URL: process.env.REDIS_URL_TEST, REDIS_KEY_PREFIX: process.env.TEST_REDIS_KEY_PREFIX,
  JWT_SECRET: 'isolated-go-realtime-test-secret', REALTIME_INTERNAL_TOKEN: randomUUID() + randomUUID(),
  REQUEST_LOGS: 'false', API_RATE_LIMIT_MAX: '100000', METRICS_TOKEN: 'isolated-metrics-token',
  AI_API_KEY: '', DASHSCOPE_API_KEY: '', DEEPSEEK_API_KEY: '', MCP_SERVERS_JSON: '[]',
});
for (const key of ['USER', 'PRIVATE', 'GROUP', 'GLOBAL']) for (const suffix of ['RATE', 'BURST']) process.env[`MESSAGE_${key}_${suffix}`] = '10000';
require('ts-node/register/transpile-only');
const { initDatabase, default: db } = require('../src/infrastructure/database');
const { Query } = require('../src/infrastructure/database-query');
const { better_chat: redis } = require('../src/infrastructure/redis');
const children = new Set(), sockets = new Set();
const measurements = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(20); }
  throw new Error(label);
}
async function freePort() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function command(file, args, env = process.env) {
  const child = spawn(file, args, { cwd: goRoot, env, stdio: 'inherit' });
  const [code] = await once(child, 'exit'); assert.equal(code, 0, `${file} ${args[0]} failed`);
}
async function launch(file, args, env, base, health) {
  const child = spawn(file, args, { cwd: path.join(root, 'server'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); let log = ''; child.on('error', e => { log += e.message; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', raw => { log = (log + raw).slice(-16000); });
  try { await eventually(async () => { if (child.exitCode !== null) throw new Error(`Service exited: ${log}`); try { return (await fetch(base + health, { signal: AbortSignal.timeout(1000) })).status === 200; } catch { return false; } }, 'Service startup timed out: ' + log, 30000); }
  catch (e) { console.error(log); throw e; }
  child.diagnostics = () => log; return child;
}
async function stop(child) { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } children.delete(child); }
async function api(base, route, token, body, method) {
  const response = await fetch(base + '/api/chat/v1/' + route, { method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const result = await response.json(); assert.equal(result.code, 200, `${route}: ${response.status} ${JSON.stringify(result)}`); return result.data;
}
async function user(base, tag) {
  const username = 'go_' + tag + '_' + randomUUID().slice(0, 8), password = 'RealtimeTest123!';
  await api(base, 'auth/register', '', { username, password, phone: '13' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0'), avatar: '' });
  return { username, password, ...await api(base, 'auth/login', '', { username, password }) };
}
async function connect(base, a, room, type = 'private', notification = false, immediate) {
  const url = base.replace('http:', 'ws:') + '/api/chat/v1/' + (notification ? `auth/user_channel?username=${a.username}&token=${a.token}` : `message/connect_chat?room=${room}&type=${type}&id=${a.info.id}`);
  const ws = new WS(url, notification ? undefined : ['pomelo-token', a.token]); const peer = { ws, frames: [], ackAt: new Map(), receivedAt: new Map(), closed: false }; sockets.add(ws);
  ws.on('error', () => {}); ws.on('close', () => { peer.closed = true; sockets.delete(ws); });
  ws.on('message', raw => { const frame = JSON.parse(raw); peer.frames.push(frame); if (frame.name === 'ack') peer.ackAt.set(frame.client_msg_id, performance.now()); else if (frame.id) peer.receivedAt.set(frame.id, performance.now()); if (frame.receipt && ws.readyState === 1) ws.send(JSON.stringify({ name: 'delivery_ack', receipt: frame.receipt })); });
  await once(ws, 'open'); if (immediate) ws.send(JSON.stringify(immediate));
  if (!notification) await eventually(() => peer.frames.some(f => f.name === 'history'), 'Missing initial history');
  return peer;
}
async function send(peer, content, type = 'text', id = 'go-' + randomUUID()) {
  const start = peer.frames.length; peer.ws.send(JSON.stringify({ content, type, clientMsgId: id }));
  return eventually(() => { const response = peer.frames.slice(start).find(f => ['ack', 'error'].includes(f.name) && f.client_msg_id === id); if (!response && peer.closed) throw new Error('Socket closed before ACK'); return response; }, 'Missing send response');
}
async function denySocket(base, a, room) {
  const ws = new WS(`${base.replace('http:', 'ws:')}/api/chat/v1/message/connect_chat?room=${room}&type=private&id=${a.info.id}`, ['pomelo-token', a.token]); sockets.add(ws);
  const rejected = await new Promise(resolve => { const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 5000); ws.on('error', () => { clearTimeout(timer); resolve(true); }); ws.on('message', raw => { if (JSON.parse(raw).name === 'error') { clearTimeout(timer); resolve(true); } }); });
  ws.terminate(); sockets.delete(ws); assert.ok(rejected, 'Unauthorized room accepted');
}
function resources(services) {
  const ids = services.map(child => child.pid).filter(id => Number.isInteger(id) && id > 0);
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${ids.join(',')} | Select-Object Id,CPU,WorkingSet64 | ConvertTo-Json -Compress`], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Process resource sampling failed');
    const rows = JSON.parse(result.stdout.replace(/^\uFEFF/, '')); return [].concat(rows).map(row => ({ pid: row.Id, cpuSeconds: row.CPU || 0, rssBytes: row.WorkingSet64 }));
  }
  const ticks = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim());
  if (!ticks) throw new Error('Cannot determine process CPU clock');
  return ids.map(pid => {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return { pid, cpuSeconds: (Number(fields[11]) + Number(fields[12])) / ticks, rssBytes: Number(rss?.[1] || 0) * 1024 };
  });
}
async function measure(label, sender, receivers, services) {
  const ackMs = [], receiveMs = [], before = resources(services); const start = performance.now();
  for (let i = 0; i < 45; i++) {
    const content = `perf-${label}-${i}-` + 'x'.repeat(128), at = performance.now();
    const ack = await send(sender, content); assert.equal(ack.name, 'ack');
    const ackTime = sender.ackAt.get(ack.client_msg_id) - at;
    await eventually(() => receivers.every(peer => peer.frames.some(frame => frame.id === ack.id)), 'Measured delivery missing');
    const received = Math.max(...receivers.map(peer => peer.receivedAt.get(ack.id))) - at;
    if (i >= 5) { ackMs.push(ackTime); receiveMs.push(received); }
    await delay(Math.max(0, 50 - (performance.now() - at)));
  }
  const elapsedMs = performance.now() - start, after = resources(services);
  const percentile = (values, quantile) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1];
  const row = { label, messages: 40, offeredPerSecond: 20, receiverConnections: receivers.length, elapsedMs,
    ack: { p50: percentile(ackMs, .5), p95: percentile(ackMs, .95), p99: percentile(ackMs, .99) },
    receive: { p50: percentile(receiveMs, .5), p95: percentile(receiveMs, .95), p99: percentile(receiveMs, .99) },
    cpuSeconds: after.reduce((sum, item) => sum + item.cpuSeconds, 0) - before.reduce((sum, item) => sum + item.cpuSeconds, 0),
    rssBytes: after.reduce((sum, item) => sum + item.rssBytes, 0), processSamples: after };
  measurements.push(row); console.log(`[go-realtime:measure] ${label} receive P95=${row.receive.p95.toFixed(1)}ms RSS=${Math.round(row.rssBytes / 1048576)}MiB`);
}
async function matrix(gatewayDriver, outboxDriver) {
  const services = [], nodes = [], bases = [], nodePort = await freePort();
  const env = { REALTIME_DRIVER: gatewayDriver, OUTBOX_DRIVER: outboxDriver, PORT: String(nodePort), BIND_HOST: '127.0.0.1' };
  nodes.push(await launch(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), 'src/index.ts'], env, `http://127.0.0.1:${nodePort}`, '/api/chat/v1/health')); services.push(...nodes);
  if (gatewayDriver === 'node') {
    bases.push(`http://127.0.0.1:${nodePort}`);
    const p = await freePort(); const child = await launch(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), 'src/index.ts'], { ...env, PORT: String(p) }, `http://127.0.0.1:${p}`, '/api/chat/v1/health'); services.push(child); nodes.push(child); bases.push(`http://127.0.0.1:${p}`);
  }
  for (let i = 0; i < (gatewayDriver === 'node' && outboxDriver === 'node' ? 0 : 2); i++) {
    const p = await freePort(), role = gatewayDriver === 'go' ? outboxDriver === 'go' ? 'all' : 'gateway' : 'worker';
    const base = `http://127.0.0.1:${p}`;
    services.push(await launch(binary, ['-role', role], { ...env, NODE_INTERNAL_URL: `http://127.0.0.1:${nodePort}`, GO_REALTIME_ADDR: `127.0.0.1:${p}` }, base, '/internal/ready'));
    if (gatewayDriver === 'go') bases.push(base);
  }
  const [base, other] = bases;
  try {
    const a = await user(base, 'a'), b = await user(base, 'b'), outsider = await user(base, 'outsider');
    await api(base, 'friend/add_friend', a.token, { id: b.info.id, username: b.username });
    const room = (await api(base, 'message/chat_list', a.token)).find(r => Number(r.receiver_id) === b.info.id).room;
    const internal = `http://127.0.0.1:${nodePort}/internal/realtime/send`;
    assert.equal((await fetch(internal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    for (const [token, status] of [['invalid-token', 401], [outsider.token, 403]]) {
      const response = await fetch(internal, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.REALTIME_INTERNAL_TOKEN },
        body: JSON.stringify({ token, room, type: 'private', sender_id: a.info.id, id: a.info.id, content: 'forged actor', clientMsgId: 'forged-' + randomUUID() }) });
      assert.equal(response.status, status, 'Private bridge trusted a supplied actor');
    }
    const unrelated = await connect(other, outsider, '', 'private', true);
    await eventually(() => redis.get(`presence:${outsider.username}`), 'Outsider presence missing');
    const unrelatedStart = unrelated.frames.length;
    const notify = await connect(other, b, '', 'private', true);
    await connect(base, a, '', 'private', true);
    await eventually(() => redis.get(`presence:${a.username}`), 'Sender presence missing');
    await eventually(() => redis.get(`presence:${b.username}`), 'Presence missing');
    await delay(100);
    assert.ok(!unrelated.frames.slice(unrelatedStart).some(frame => frame.name === 'friendList'), 'Presence refreshed an unrelated user');
    const id = 'first-' + randomUUID(), initial = { content: 'first frame', type: 'text', clientMsgId: id };
    const ca = await connect(base, a, room, 'private', false, gatewayDriver === 'go' ? initial : undefined);
    if (gatewayDriver === 'node') ca.ws.send(JSON.stringify(initial));
    await eventually(() => ca.frames.find(f => f.name === 'ack' && f.client_msg_id === id), 'First frame was lost');
    const cb = await connect(other, b, room);
    assert.equal((await send(ca, 'hello', 'text', 'idempotent-' + id)).name, 'ack');
    const repeated = await send(ca, 'hello', 'text', 'idempotent-' + id); assert.equal(repeated.name, 'ack');
    assert.equal((await send(ca, 'changed', 'text', 'idempotent-' + id)).name, 'error');
    await eventually(() => cb.frames.some(f => f.content === 'hello'), 'Cross-instance delivery missing');
    const normal = cb.frames.find(f => f.content === 'hello');
    const stored = await api(other, `message/history?room=${room}&type=private`, b.token);
    const matching = stored.messages.find(f => f.id === normal.id);
    const { receipt, ...wire } = normal; assert.deepEqual(wire, matching, 'Go and Node message projections differ');
    await eventually(() => notify.frames.some(f => f.name === 'chatList'), 'Chat-list notification missing');
    const [count] = await Query('SELECT COUNT(*) AS n FROM message WHERE sender_id=? AND client_msg_id=?', [a.info.id, 'idempotent-' + id]); assert.equal(count.n, 1);
    const sequences = [];
    for (let i = 0; i < 12; i++) { const ack = await send(ca, `ordered-${i}`); assert.equal(ack.name, 'ack'); sequences.push(ack.room_seq); }
    await eventually(() => cb.frames.filter(f => String(f.content).startsWith('ordered-')).length >= 12, 'Ordered delivery missing');
    const delivered = [...new Map(cb.frames.filter(f => String(f.content).startsWith('ordered-')).map(f => [f.id, f])).values()];
    assert.deepEqual(delivered.map(f => f.room_seq), sequences);
    await denySocket(other, outsider, room);
    if (gatewayDriver === 'go') {
      const markers = [ca.frames.length, cb.frames.length];
      const list = await redis.client('LIST');
      const owned = list.split('\n').map(line => Object.fromEntries(line.split(' ').map(part => part.split('='))))
        .filter(row => row.name?.startsWith(process.env.REDIS_KEY_PREFIX + 'pomelo-go-') && (Number(row.sub) > 0 || row.cmd === 'subscribe'));
      assert.equal(owned.length, outboxDriver === 'go' ? 6 : 4, 'Expected isolated data/control/wake subscribers');
      for (const row of owned) await redis.client('KILL', 'ID', row.id);
      await eventually(() => ca.frames.slice(markers[0]).some(f => f.name === 'resync') && cb.frames.slice(markers[1]).some(f => f.name === 'resync'), 'Subscription reconnect did not request recovery');
    }
    const latest = sequences.at(-1); await api(other, 'message/read', b.token, { room, type: 'private', roomSeq: latest });
    await eventually(() => ca.frames.some(f => f.name === 'read_receipt' && f.roomSeq === latest), 'Read receipt missing');
    cb.ws.close(); await eventually(() => cb.closed, 'Socket did not close'); const offline = await send(ca, 'offline gap');
    const restored = await connect(other, b, room); assert.ok(restored.frames.find(f => f.name === 'history').messages.some(f => f.id === offline.id));
    const bytes = Buffer.from('go file ' + randomUUID()), hash = createHash('sha256').update(bytes).digest('hex');
    const verified = await api(base, 'file/verify_file', a.token, { fileHash: hash, totalCount: 1, extname: 'txt' });
    const form = new FormData(); form.set('chunk', new Blob([bytes]), 'chunk.txt');
    for (const [k, v] of Object.entries({ fileHash: hash, extname: 'txt', chunkIndex: '1', uploadToken: verified.uploadToken })) form.set(k, v);
    const uploaded = await fetch(base + '/api/chat/v1/file/upload_chunk', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: form }); assert.equal(uploaded.status, 200);
    const merged = await api(base, 'file/merge_chunk', a.token, { fileHash: hash, extname: 'txt', uploadToken: verified.uploadToken });
    assert.equal((await send(ca, merged.filePath, 'file')).name, 'ack');
    const downloaded = await fetch(other + merged.filePath, { headers: { Authorization: 'Bearer ' + b.token } }); assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
    assert.equal((await fetch(other + merged.filePath, { headers: { Authorization: 'Bearer ' + outsider.token } })).status, 404);
    const prepared = await api(base, 'assistant/actions/message-draft', a.token, { room, chatType: 'private', content: 'confirmed through go' });
    await api(base, 'assistant/actions/confirm', a.token, { confirmationId: prepared.action.confirmationId });
    await eventually(() => restored.frames.some(f => f.content === 'confirmed through go'), 'Confirmed assistant message missing');
    const invited = await api(base, 'rtc/invite', a.token, { room, type: 'private', mode: 'private_audio' });
    await eventually(() => notify.frames.some(f => f.name === 'rtc_invite' || JSON.stringify(f).includes(invited.callId)), 'RTC notification missing');
    await api(other, 'rtc/accept', b.token, { callId: invited.callId }); await api(base, 'rtc/end', a.token, { callId: invited.callId });
    await measure(`${gatewayDriver}-${outboxDriver}-private`, ca, [restored], services);
    await api(base, 'group/create_group', a.token, { name: 'Go worker group', members: [{ user_id: b.info.id, username: b.username }] });
    const group = (await Query('SELECT id,room FROM group_chat WHERE creator_id=? ORDER BY id DESC LIMIT 1', [a.info.id]))[0];
    const groupSender = await connect(base, a, group.room, 'group');
    const groupReceivers = await Promise.all(Array.from({ length: 10 }, () => connect(other, b, group.room, 'group')));
    await measure(`${gatewayDriver}-${outboxDriver}-group`, groupSender, groupReceivers, services);
    assert.ok((await api(base, 'message/chat_list', b.token)).some(item => item.receiver_id === group.id && item.room === group.room));
    const deniedRemoval = await fetch(base + '/api/chat/v1/group/remove_member', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + outsider.token }, body: JSON.stringify({ groupId: group.id, userId: b.info.id }) });
    assert.notEqual((await deniedRemoval.json()).code, 200, 'An outsider removed a member');
    const lock = await new Promise((resolve, reject) => db.getConnection((error, connection) => error ? reject(error) : resolve(connection)));
    const sql = lock.promise(), raceId = 'revoke-race-' + randomUUID(); let pending;
    const queueMetrics = gatewayDriver === 'node' ? other : `http://127.0.0.1:${nodePort}`;
    const queuePending = async () => { const response = await fetch(queueMetrics + '/internal/metrics', { headers: { Authorization: 'Bearer ' + process.env.METRICS_TOKEN } }); const text = await response.text(); return Number(/pomelo_message_write_queue_pending (\d+)/.exec(text)?.[1] || 0); };
    try {
      await sql.beginTransaction(); await sql.query('SELECT id FROM conversation WHERE room=? FOR UPDATE', [group.room]);
      pending = send(groupReceivers[0], 'must not commit after revoke', 'text', raceId).catch(() => undefined);
      await eventually(async () => await queuePending() > 0, 'Race send did not reach the transaction queue');
      await api(base, 'group/remove_member', a.token, { groupId: group.id, userId: b.info.id });
    } finally { await sql.rollback(); lock.release(); }
    await pending; await eventually(async () => await queuePending() === 0, 'Revoked queued write did not finish');
    assert.equal((await Query('SELECT id FROM message WHERE client_msg_id=?', [raceId])).length, 0, 'A queued message committed after membership revocation');
    await eventually(() => groupReceivers.every(peer => peer.closed), 'Membership revocation did not close existing connections');
    const afterRemoval = groupReceivers.map(peer => peer.frames.length);
    assert.equal((await send(groupSender, 'after removal')).name, 'ack');
    await delay(100); groupReceivers.forEach((peer, index) => assert.ok(!peer.frames.slice(afterRemoval[index]).some(frame => frame.content === 'after removal'), 'Removed member received a new message'));
    const replacement = await connect(base, b, '', 'private', true); await eventually(() => notify.closed, 'Replaced notification socket remained open');
    const lease = await redis.get(`presence:${b.username}`); await delay(100); assert.equal(await redis.get(`presence:${b.username}`), lease, 'Old connection removed new presence');
    await api(base, 'auth/login', '', { username: b.username, password: b.password });
    await eventually(() => restored.closed && replacement.closed, 'Revoked token sockets remained open');
    if (gatewayDriver === 'go') {
      assert.equal((await fetch(base + '/internal/realtime/send', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.REALTIME_INTERNAL_TOKEN } })).status, 404);
      assert.equal((await fetch(base + '/internal/metrics')).status, 404);
      const metrics = await (await fetch(base + '/internal/metrics', { headers: { Authorization: 'Bearer ' + process.env.METRICS_TOKEN } })).text(); assert.match(metrics, /pomelo_socket_connections/);
    }
    await eventually(async () => !(await Query('SELECT message_id FROM message_outbox WHERE delivered_at IS NULL')).length, 'Pending Outbox did not drain');
    console.log(`[go-realtime] ${gatewayDriver} gateway / ${outboxDriver} worker: cross-instance protocol, ordering, files, confirmation, RTC, replacement and revocation passed`);
  } catch (e) { for (const service of services) console.error(service.diagnostics()); throw e; }
  finally { for (const ws of [...sockets]) ws.terminate(); await delay(50); for (const service of services.reverse()) await stop(service); }
}
async function soak() {
  const seconds = Number(process.env.SOAK_SECONDS || 60), members = Number(process.env.SOAK_GROUP_MEMBERS || 16);
  if (!Number.isInteger(seconds) || seconds < 15 || seconds > 3600 || !Number.isInteger(members) || members < 2 || members > 100) throw new Error('SOAK_SECONDS must be 15..3600 and SOAK_GROUP_MEMBERS 2..100');
  const directory = path.join(root, 'test-results', `realtime-soak-${Date.now()}`); fs.mkdirSync(directory, { recursive: true });
  const report = { scope: 'Fixed-rate real Go gateway/worker soak with private rooms and a group of distinct users. Default message admission; test-only 6s worker leases accelerate crash recovery. Local host, not production capacity.', seconds, groupReceivers: members, privatePairs: 4, faults: [], retries: 0, reconciled: 0, scheduledLate: 0, accepted: 0, checks: [], error: null };
  const services = [], observers = [], jobs = [], workers = [], gateways = [];
  const nodePort = await freePort(), baseNode = `http://127.0.0.1:${nodePort}`;
  const env = { REALTIME_DRIVER: 'go', OUTBOX_DRIVER: 'go', PORT: String(nodePort), BIND_HOST: '127.0.0.1', NODE_INTERNAL_URL: baseNode, OUTBOX_LEASE_SECONDS: '6',
    MESSAGE_USER_RATE: '5', MESSAGE_USER_BURST: '10', MESSAGE_PRIVATE_RATE: '10', MESSAGE_PRIVATE_BURST: '20', MESSAGE_GROUP_RATE: '20', MESSAGE_GROUP_BURST: '20', MESSAGE_GLOBAL_RATE: '150', MESSAGE_GLOBAL_BURST: '100' };
  const launchRole = async (role, port) => launch(binary, ['-role', role], { ...env, GO_REALTIME_ADDR: `127.0.0.1:${port}` }, `http://127.0.0.1:${port}`, '/internal/ready');
  let running = true;
  try {
    services.push(await launch(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), 'src/index.ts'], env, baseNode, '/api/chat/v1/health'));
    for (let i = 0; i < 2; i++) { const port = await freePort(), entry = { port, base: `http://127.0.0.1:${port}`, child: await launchRole('gateway', port) }; gateways.push(entry); services.push(entry.child); }
    for (let i = 0; i < 2; i++) { const port = await freePort(), entry = { port, child: await launchRole('worker', port) }; workers.push(entry); services.push(entry.child); }
    const base = gateways[0].base;
    const observer = async (gateway, auth, room, type) => {
      const state = { gateway, auth, room, type, peer: null, connecting: null, recovering: null, seen: new Map(), cursor: 0, sequences: new Set(), duplicates: 0, liveOrderErrors: 0, lastLive: 0 };
      state.record = (frame, replay = false) => {
        if (!frame.id || frame.room !== room) return;
        if (state.seen.has(frame.id)) { state.duplicates++; return; }
        if (!replay && frame.room_seq < state.lastLive) state.liveOrderErrors++;
        if (!replay) state.lastLive = Math.max(state.lastLive, frame.room_seq);
        state.seen.set(frame.id, { ...frame, receivedAt: performance.now(), replay }); state.sequences.add(frame.room_seq);
        while (state.sequences.has(state.cursor + 1)) { state.sequences.delete(++state.cursor); }
      };
      state.recover = async () => {
        if (state.recovering) return state.recovering;
        state.recovering = (async () => {
          let more = true, cursor = state.cursor;
          while (more) { const history = await api(gateway.base, `message/history?room=${encodeURIComponent(room)}&type=${type}&afterSeq=${cursor}&limit=80`, auth.token);
            for (const frame of history.messages) state.record(frame, true);
            if (!history.messages.length) break; cursor = history.messages.at(-1).room_seq; more = history.hasMore;
          }
        })().finally(() => { state.recovering = null; }); return state.recovering;
      };
      state.ensure = async () => {
        if (state.connecting) return state.connecting;
        if (state.peer?.ws.readyState === 1) return state.peer;
        state.connecting = (async () => {
          for (let attempt = 0; attempt < 30; attempt++) {
            try {
              const peer = await connect(gateway.base, auth, room, type); state.peer = peer;
              for (const frame of peer.frames) { if (frame.name === 'history') frame.messages.forEach(message => state.record(message, true)); else state.record(frame); }
              peer.ws.on('message', raw => { const frame = JSON.parse(raw); state.record(frame); if (frame.name === 'resync') void state.recover().catch(() => undefined); });
              await state.recover(); return peer;
            } catch { if (attempt === 29) throw new Error('Gateway did not recover'); await delay(250); }
          }
        })().finally(() => { state.connecting = null; }); return state.connecting;
      };
      await state.ensure(); observers.push(state); return state;
    };
    const pairs = [];
    for (let i = 0; i < 4; i++) {
      const a = await user(base, 'soak_a'), b = await user(base, 'soak_b'); await api(base, 'friend/add_friend', a.token, { id: b.info.id, username: b.username });
      const room = (await api(base, 'message/chat_list', a.token)).find(item => Number(item.receiver_id) === b.info.id).room;
      const sender = await observer(gateways[i % 2], a, room, 'private'), receiver = await observer(gateways[(i + 1) % 2], b, room, 'private');
      jobs.push({ sender, receivers: [receiver], ids: new Map(), latencies: [] }); pairs.push({ a, b });
    }
    const owner = pairs[0].a, groupUsers = [pairs[0].b];
    for (let i = 1; i < members; i++) { const member = await user(base, 'soak_group'); groupUsers.push(member); await api(base, 'friend/add_friend', owner.token, { id: member.info.id, username: member.username }); }
    await api(base, 'group/create_group', owner.token, { name: 'Sustained distinct-member group', members: groupUsers.map(member => ({ user_id: member.info.id, username: member.username })) });
    const group = (await Query('SELECT id,room FROM group_chat WHERE creator_id=? ORDER BY id DESC LIMIT 1', [owner.info.id]))[0];
    const groupSender = await observer(gateways[0], owner, group.room, 'group');
    const groupObservers = []; for (let i = 0; i < groupUsers.length; i++) groupObservers.push(await observer(gateways[i % 2], groupUsers[i], group.room, 'group'));
    jobs.push({ sender: groupSender, receivers: groupObservers, ids: new Map(), latencies: [] });
    const start = performance.now(), finish = start + seconds * 1000;
    const revive = async (entry, role) => { entry.child = await launchRole(role, entry.port); services.push(entry.child); };
    const faults = (async () => {
      await delay(seconds * 1000 * .25); await stop(workers[0].child); report.faults.push({ type: 'worker-process-kill', atSeconds: (performance.now() - start) / 1000 });
      await delay(1000); await revive(workers[0], 'worker');
      await delay(Math.max(0, start + seconds * 1000 * .5 - performance.now())); await stop(gateways[1].child); report.faults.push({ type: 'gateway-process-kill', atSeconds: (performance.now() - start) / 1000 });
      await delay(1000); await revive(gateways[1], 'gateway');
      await delay(Math.max(0, start + seconds * 1000 * .75 - performance.now()));
      const list = await redis.client('LIST'); const subscribers = list.split('\n').map(line => Object.fromEntries(line.split(' ').map(part => part.split('=')))).filter(row => row.name?.startsWith(process.env.REDIS_KEY_PREFIX + 'pomelo-go-') && Number(row.sub) > 0);
      for (const client of subscribers) await redis.client('KILL', 'ID', client.id);
      report.faults.push({ type: 'redis-subscriptions-killed', connections: subscribers.length, atSeconds: (performance.now() - start) / 1000 });
    })();
    const progress = setInterval(() => console.log(`[realtime-soak] ${Math.round((performance.now() - start) / 1000)}s accepted=${report.accepted} retries=${report.retries}`), 15000);
    try {
      await Promise.all(jobs.map(async (job, index) => {
        let next = start;
        while (performance.now() < finish && running) {
          await delay(Math.max(0, next - performance.now())); if (performance.now() >= finish) break;
          if (performance.now() - next > 500) { report.scheduledLate++; next = performance.now(); }
          next += 500;
          const id = `soak-${index}-${randomUUID()}`, content = `sustained-${index}-${id}`, at = performance.now(); let ack;
          for (let attempt = 0; attempt < 5; attempt++) {
            try { const peer = await job.sender.ensure(); ack = await send(peer, content, 'text', id); if (ack.name === 'ack') break;
              if (!ack.retryable) throw new Error('Non-retryable send error'); await delay(Math.min(ack.retryAfterMs || 500, 3000));
            } catch { job.sender.peer?.ws.terminate(); }
            report.retries++; ack = null;
          }
          if (!ack || ack.name !== 'ack') {
            const rows = await Query('SELECT id,room_seq,client_msg_id FROM message WHERE sender_id=? AND client_msg_id=?', [job.sender.auth.info.id, id]);
            if (rows.length !== 1) throw new Error('Unresolved message after bounded retries'); ack = rows[0]; report.reconciled++;
          }
          job.ids.set(ack.id, { id, at }); report.accepted++;
          await Promise.all(job.receivers.map(receiver => receiver.ensure()));
        }
      }));
      await faults;
      await eventually(async () => !(await Query('SELECT message_id FROM message_outbox WHERE delivered_at IS NULL')).length, 'Outbox did not recover after faults', 30000);
      for (const receiver of observers) { await receiver.ensure(); await receiver.recover(); }
      for (const job of jobs) for (const [id, entry] of job.ids) {
        for (const receiver of job.receivers) { const message = receiver.seen.get(id); assert.ok(message, 'A committed message was not recovered by its recipient'); job.latencies.push(message.receivedAt - entry.at); }
        const rows = await Query('SELECT id FROM message WHERE sender_id=? AND client_msg_id=?', [job.sender.auth.info.id, entry.id]); assert.equal(rows.length, 1, 'Retry created duplicate business rows');
      }
      assert.ok(observers.every(receiver => receiver.liveOrderErrors === 0), 'Live unique room messages arrived out of order');
      assert.ok(report.faults.length === 3 && report.faults[2].connections > 0, 'Faults were not exercised');
      report.elapsedSeconds = (performance.now() - start) / 1000;
      report.targetMessagesPerSecond = jobs.length * 2;
      report.targetSlots = seconds * jobs.length * 2;
      report.notGeneratedSlots = Math.max(0, report.targetSlots - report.accepted);
      report.jobs = jobs.map((job, index) => { const sorted = job.latencies.sort((a, b) => a - b); return { index, accepted: job.ids.size, receivers: job.receivers.length, p95IncludingRecoveryMs: sorted[Math.ceil(sorted.length * .95) - 1] || 0 }; });
      report.checks = ['committed messages recovered', 'duplicate business writes absent', 'live room order preserved', 'worker/gateway/subscriber failures recovered'];
      console.log(`[realtime-soak] passed accepted=${report.accepted}; ${path.relative(root, directory)}/report.json`);
    } finally { clearInterval(progress); running = false; await faults.catch(() => undefined); }
  } catch (error) { report.error = error.message; throw error; }
  finally {
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    for (const peer of sockets) peer.terminate(); for (const service of services.reverse()) await stop(service);
  }
}
(async () => {
  try {
    await command('go', ['build', '-o', binary, '.']); await initDatabase(); await redis.connect();
    if (process.argv.includes('--soak')) { await soak(); return; }
    await command('go', ['test', '-v', './...'], { ...process.env, GO_INTEGRATION: '1' });
    for (const pair of [['node', 'node'], ['node', 'go'], ['go', 'node'], ['go', 'go']]) await matrix(...pair);
    const directory = path.join(root, 'test-results', `go-realtime-${Date.now()}`); fs.mkdirSync(directory, { recursive: true });
    const comparisons = ['private', 'group'].map(kind => {
      const baseline = measurements.find(row => row.label === `node-node-${kind}`), candidate = measurements.find(row => row.label === `go-go-${kind}`);
      const budget = Math.max(baseline.receive.p95 * 1.5, baseline.receive.p95 + 15);
      return { kind, baselineP95: baseline.receive.p95, goP95: candidate.receive.p95, budget, passed: candidate.receive.p95 <= budget };
    });
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ scope: 'Local sequential fixed-rate smoke comparison; 2 gateways and 2 workers (combined processes where supported), 2 group members with 10 receiver connections, elevated admission budgets, 5 warmup + 40 measured messages, success-only percentiles with all sends required to succeed; RSS snapshots are not peak memory; not production capacity.', measurements, comparisons }, null, 2));
    console.log(`[go-realtime] report: ${path.relative(root, directory)}/report.json`);
    assert.ok(comparisons.every(row => row.passed), 'Go receive P95 regressed beyond the declared smoke budget');
  } finally {
    for (const ws of sockets) ws.terminate(); for (const child of [...children]) await stop(child);
    redis.disconnect(); await new Promise(resolve => db.end(resolve)); if (fs.existsSync(binary)) fs.unlinkSync(binary);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
