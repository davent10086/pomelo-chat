// Admission stays at production defaults. Only HTTP fixture budget is raised.
import { startChatBackend } from './chat-backend.mjs';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const require = createRequire(path.resolve('server/package.json')), WS = require('ws');
const output = path.resolve('test-results', `message-protection-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const token = randomUUID(), rows = [], peers = [];
let backend;
const defaults = { MESSAGE_USER_RATE: 5, MESSAGE_USER_BURST: 10, MESSAGE_PRIVATE_RATE: 10,
  MESSAGE_PRIVATE_BURST: 20, MESSAGE_GROUP_RATE: 20, MESSAGE_GROUP_BURST: 20,
  MESSAGE_GLOBAL_RATE: 150, MESSAGE_GLOBAL_BURST: 100, MESSAGE_ROOM_QUEUE_MAX: 32,
  MESSAGE_WRITE_QUEUE_MAX: 256, MESSAGE_OUTBOX_MAX_PENDING: 500,
  MESSAGE_OUTBOX_ROOM_MAX_PENDING: 40, MESSAGE_OUTBOX_MAX_AGE_SECONDS: 3 };
Object.assign(process.env, Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, String(value)])),
  { API_RATE_LIMIT_MAX: '1000000', METRICS_TOKEN: token });
const fail = (condition, label) => { if (!condition) throw Error(label); };
async function api(route, auth, body) {
  const response = await fetch(`${backend.base}/api/chat/v1/${route}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  const json = await response.json(); fail(response.ok && json.code === 200, `fixture ${route}`); return json.data;
}
async function connect(auth, room, type = 'private') {
  return new Promise((resolve, reject) => {
    const base = backend.instances[peers.length % backend.instances.length].base;
    const ws = new WS(`${base.replace('http:', 'ws:')}/api/chat/v1/message/connect_chat?room=${room}&id=${auth.info.id}&type=${type}`, ['pomelo-token', auth.token]);
    const peer = { ws, seen: new Set(), pending: new Map(), last: 0, duplicates: 0, orderErrors: 0 };
    peers.push(peer);
    const timer = setTimeout(() => reject(Error('history timeout')), 10000);
    ws.on('error', reject);
    ws.on('message', raw => {
      const frame = JSON.parse(raw);
      if (frame.name === 'history') { clearTimeout(timer); resolve(peer); return; }
      if (frame.name === 'ack' || frame.name === 'error') { peer.pending.get(frame.client_msg_id)?.(frame); return; }
      if (frame.id && frame.client_msg_id?.startsWith('protect-')) {
        if (peer.seen.has(frame.client_msg_id)) peer.duplicates++;
        else { peer.seen.add(frame.client_msg_id); if (frame.room_seq <= peer.last) peer.orderErrors++; peer.last = frame.room_seq; }
      }
      if (frame.receipt) ws.send(JSON.stringify({ name: 'delivery_ack', receipt: frame.receipt }));
    });
  });
}
function send(peer, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { peer.pending.delete(id); reject(Error('ACK timeout')); }, 10000);
    peer.pending.set(id, frame => { clearTimeout(timer); peer.pending.delete(id); resolve(frame); });
    peer.ws.send(JSON.stringify({ content: id, clientMsgId: id, type: 'text' }));
  });
}
async function wait(check, label, timeout = 10000) {
  const until = performance.now() + timeout;
  while (!check()) { if (performance.now() > until) throw Error(label); await sleep(5); }
}
async function phase(name, concurrency, operation) {
  let attempts = 0, success = 0, rejected = 0;
  const errors = {}, latencies = [], start = performance.now(), until = start + 15000;
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    while (performance.now() < until) {
      const id = `protect-${name}-${attempts++}`, began = performance.now();
      try {
        const result = await operation(worker, id);
        if (result.name === 'error') {
          fail(result.code === 'MESSAGE_OVERLOADED' && result.retryable && result.retryAfterMs > 0, 'unexpected rejection');
          rejected++; await sleep(Math.max(50, Math.min(2000, result.retryAfterMs)) + Math.random() * 50);
        } else { success++; latencies.push(performance.now() - began); }
      } catch (error) { errors[error.message] = (errors[error.message] || 0) + 1; }
    }
  }));
  latencies.sort((a, b) => a - b);
  const pct = p => latencies.length ? latencies[Math.ceil(latencies.length * p) - 1] : null;
  const seconds = (performance.now() - start) / 1000;
  const row = { name, concurrency, attempts, success, rejected, errors, seconds,
    successPerSecond: success / seconds, p95Ms: pct(.95), p99Ms: pct(.99) };
  rows.push(row); console.log(JSON.stringify(row));
}
await mkdir(output, { recursive: true });
let report = { defaults, scope: 'Single-machine closed-loop, 15 seconds per phase, explicit rejection separated from unexpected errors. Private latency includes recipient; group phase measures ACK, with recipient integrity checked after drain. Not a production capacity estimate.' };
try {
  backend = await startChatBackend(process.cwd());
  report.topology = { instances: backend.instances.map(({ pid, base }) => ({ pid, base })), versions: backend.versions,
    distribution: 'Round-robin sockets; private sender and receiver on different instances when BENCH_INSTANCES=2' };
  const clients = await backend.createIndependentPeers(50, true), privatePeers = [];
  for (const c of clients.slice(0, 25)) privatePeers.push({ a: await connect(c.auth, c.room.room), b: await connect(c.receiverAuth, c.room.room) });
  await phase('private', 25, async (worker, id) => {
    const pair = privatePeers[worker], ack = await send(pair.a, id);
    if (ack.name === 'ack') await wait(() => pair.b.seen.has(id), 'private recipient timeout');
    return ack;
  });
  const owner = clients[0].auth;
  for (const c of clients.slice(1)) await api('friend/add_friend', owner, { id: c.auth.info.id, username: c.auth.info.username });
  await api('group/create_group', owner, { name: 'Protected group', avatar: '', members: clients.slice(1).map(c => ({ user_id: c.auth.info.id, username: c.auth.info.username })) });
  const group = (await api('group/group_list', owner)).find(g => g.name === 'Protected group');
  const groupPeers = await Promise.all(clients.map(c => connect(c.auth, group.room, 'group'))), sent = new Set();
  await phase('group', 20, async (worker, id) => { const result = await send(groupPeers[worker], id); if (result.name === 'ack') sent.add(id); return result; });
  const began = performance.now();
  await wait(() => groupPeers.every(p => [...sent].every(id => p.seen.has(id))), 'group recipient drain timeout');
  const drainMs = performance.now() - began;
  const deadline = performance.now() + 10000;
  let audit;
  do { audit = await backend.auditMessages(); if (!Number(audit.pendingOutbox)) break; await sleep(50); } while (performance.now() < deadline);
  fail(!Number(audit.pendingOutbox) && !audit.sequenceErrors.length && !audit.statisticsErrors.length, 'final database audit');
  fail(!peers.some(p => p.orderErrors || p.duplicates), 'recipient order/duplicate anomaly');
  fail(rows.every(row => row.success > 0 && row.rejected > 0 && !Object.keys(row.errors).length), 'phase rejection/error expectations');
  const response = await fetch(backend.base + '/internal/metrics', { headers: { Authorization: `Bearer ${token}` } });
  fail(response.ok, 'metrics access');
  await writeFile(path.join(output, 'metrics.prom'), await response.text());
  report = { ...report, completed: true, rows, audit, group: { accepted: sent.size, recipients: 50, confirmedDeliveries: sent.size * 50, drainMs } };
} catch (error) { report = { ...report, completed: false, rows, fatal: error.message }; process.exitCode = 1; }
finally {
  for (const peer of peers) peer.ws.terminate();
  if (backend) await backend.close();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${output}`);
}
