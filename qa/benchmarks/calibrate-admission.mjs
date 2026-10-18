// Serialized operating-profile trials; no production account/database is used.
import { startChatBackend } from './chat-backend.mjs';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(path.resolve('server/package.json')), WS = require('ws');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = path.resolve('test-results', `admission-calibration-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const defaults = { MESSAGE_USER_RATE: 5, MESSAGE_USER_BURST: 10, MESSAGE_PRIVATE_RATE: 10,
  MESSAGE_PRIVATE_BURST: 20, MESSAGE_GROUP_RATE: 30, MESSAGE_GROUP_BURST: 60,
  MESSAGE_GLOBAL_RATE: 250, MESSAGE_GLOBAL_BURST: 500, MESSAGE_ROOM_QUEUE_MAX: 64,
  MESSAGE_WRITE_QUEUE_MAX: 1024, MESSAGE_OUTBOX_MAX_PENDING: 5000,
  MESSAGE_OUTBOX_ROOM_MAX_PENDING: 200, MESSAGE_OUTBOX_MAX_AGE_SECONDS: 10 };
const profiles = [
  { name: 'current', settings: { ...defaults } },
  { name: 'balanced', settings: { ...defaults, MESSAGE_GROUP_RATE: 60, MESSAGE_GROUP_BURST: 60,
    MESSAGE_GLOBAL_RATE: 300, MESSAGE_GLOBAL_BURST: 300, MESSAGE_ROOM_QUEUE_MAX: 32,
    MESSAGE_WRITE_QUEUE_MAX: 256, MESSAGE_OUTBOX_MAX_PENDING: 1000,
    MESSAGE_OUTBOX_ROOM_MAX_PENDING: 120, MESSAGE_OUTBOX_MAX_AGE_SECONDS: 5 } },
  { name: 'high', settings: { ...defaults, MESSAGE_GROUP_RATE: 100, MESSAGE_GROUP_BURST: 200,
    MESSAGE_GLOBAL_RATE: 500, MESSAGE_GLOBAL_BURST: 500, MESSAGE_OUTBOX_ROOM_MAX_PENDING: 500 } },
  { name: 'conservative', settings: { ...defaults, MESSAGE_GROUP_RATE: 20, MESSAGE_GROUP_BURST: 20,
    MESSAGE_GLOBAL_RATE: 200, MESSAGE_GLOBAL_BURST: 200, MESSAGE_ROOM_QUEUE_MAX: 32,
    MESSAGE_WRITE_QUEUE_MAX: 256, MESSAGE_OUTBOX_MAX_PENDING: 500,
    MESSAGE_OUTBOX_ROOM_MAX_PENDING: 40, MESSAGE_OUTBOX_MAX_AGE_SECONDS: 3 } }
];
profiles.push({ name: 'steady', settings: { ...profiles.find(p => p.name === 'conservative').settings,
  MESSAGE_GLOBAL_RATE: 150, MESSAGE_GLOBAL_BURST: 100 } });
const selected = (process.env.CALIBRATION_PROFILES || process.env.CALIBRATION_PROFILE)?.split(',');
if (selected?.some(name => !profiles.some(p => p.name === name))) throw Error('Unknown CALIBRATION_PROFILE');
const selectedPhases = process.env.CALIBRATION_PHASES?.split(',');
if (selectedPhases?.some(name => !['normal', 'private-load', 'hot-group', 'mixed', 'single-room-burst', 'global-burst'].includes(name)))
  throw Error('Unknown CALIBRATION_PHASES');
const seconds = Number(process.env.CALIBRATION_SECONDS || 12);
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 120) throw Error('Duration must be 5..120');
const report = { protocolVersion: 2, started: new Date().toISOString(), node: process.version, cpu: os.cpus()[0].model,
  outboxSha256: createHash('sha256').update(await readFile('server/src/modules/messaging/outbox.ts')).digest('hex'), selectedPhases,
  logicalCpus: os.cpus().length, memoryGiB: os.totalmem() / 2 ** 30, secondsPerPhase: seconds,
  targets: { privateP95Ms: 500, groupAllRecipientsP95Ms: 1000, drainSeconds: 5 }, trials: [],
  limitations: 'Local shared hardware and loopback; fixed offered rate, max 1000 outstanding messages; generator drops counted. Successful-operation percentiles plus missing receipts and rejections. Group latency waits for all 50 connected recipients including sender echo. Multivariate operating profiles, not isolated causal experiments or a production capacity claim.' };
await mkdir(output, { recursive: true });
const save = () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const pct = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
const metric = (text, name) => Number(new RegExp(`^${name} ([0-9.e+-]+)$`, 'm').exec(text)?.[1] || 0);
for (const profile of profiles.filter(p => !selected || selected.includes(p.name))) {
  const trial = { name: profile.name, settings: profile.settings, phases: [] };
  report.trials.push(trial); await save();
  console.log(`START ${profile.name}`);
  const token = randomUUID(), peers = [], entries = new Map(), loop = monitorEventLoopDelay({ resolution: 10 });
  let backend, current, sampler, sampling = false;
  Object.assign(process.env, Object.fromEntries(Object.entries(profile.settings).map(([k, v]) => [k, String(v)])),
    { API_RATE_LIMIT_MAX: '1000000', METRICS_TOKEN: token });
  const api = async (route, auth, body) => {
    const r = await fetch(`${backend.base}/api/chat/v1/${route}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const json = await r.json(); if (!r.ok || json.code !== 200) throw Error(`Fixture ${route}/${r.status}/${json.code}`);
    return json.data;
  };
  const scrape = async () => {
    const r = await fetch(backend.base + '/internal/metrics', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw Error('Metrics scrape failed'); return r.text();
  };
  async function sample() {
    if (!current || sampling) return; sampling = true;
    const row = current;
    try {
      const text = await scrape();
      row.samples.push({ elapsedMs: performance.now() - row.start, pending: metric(text, 'pomelo_outbox_pending'),
        oldestSeconds: metric(text, 'pomelo_outbox_oldest_seconds'), queue: metric(text, 'pomelo_message_write_queue_pending'),
        sampleHealthy: metric(text, 'pomelo_outbox_sample_healthy'), sampleTimestamp: metric(text, 'pomelo_outbox_sample_timestamp_seconds') });
    } catch (e) { row.samplingErrors.push(e.message); }
    finally { sampling = false; }
  }
  async function connect(auth, room, type = 'private') {
    return new Promise((resolve, reject) => {
      const ws = new WS(`${backend.base.replace('http:', 'ws:')}/api/chat/v1/message/connect_chat?room=${encodeURIComponent(room)}&id=${auth.info.id}&type=${type}`, ['pomelo-token', auth.token]);
      const peer = { ws, key: String(peers.length), room, last: 0, expectedClose: false };
      peers.push(peer);
      const timer = setTimeout(() => { ws.terminate(); reject(Error('Connect timeout')); }, 15000);
      ws.on('error', error => { clearTimeout(timer); reject(error); });
      ws.on('close', () => { if (!peer.expectedClose && current) current.unexpectedCloses++; });
      ws.on('message', raw => {
        const f = JSON.parse(raw);
        if (f.name === 'history') { clearTimeout(timer); resolve(peer); return; }
        if (f.receipt) ws.send(JSON.stringify({ name: 'delivery_ack', receipt: f.receipt }));
        const e = entries.get(f.client_msg_id);
        if (!e) return;
        if (f.name === 'ack') { e.ack = performance.now(); e.settle(); return; }
        if (f.name === 'error') { e.reject = f; e.settle(); return; }
        if (f.id) {
          if (e.seen.has(peer.key)) e.row.duplicates++;
          else {
            e.seen.add(peer.key);
            if (Number(f.room_seq) <= peer.last) e.row.orderErrors++;
            peer.last = Number(f.room_seq); e.lastReceipt = performance.now(); e.settle();
          }
        }
      });
    });
  }
  async function phase(name, offeredRate, route, burst = false) {
    if (selectedPhases && !selectedPhases.includes(name)) return;
    const before = await scrape(), start = performance.now();
    const row = { name, offeredRate, start, attempted: 0, accepted: 0, received: 0, rejected: 0,
      generatorDropped: 0, maxSchedulerLagMs: 0, duplicates: 0, orderErrors: 0, unexpectedCloses: 0,
      errors: {}, rejectionCodes: {}, samples: [], samplingErrors: [], ackLatencies: [], deliveryLatencies: [], privateLatencies: [], groupLatencies: [] };
    current = row; entries.clear(); loop.reset();
    let outstanding = 0;
    function send(index) {
      const target = route(index), id = `cal-${name}-${index}`;
      const e = { row, began: performance.now(), seen: new Set(), expected: target.expected, kind: target.kind, settled: false };
      e.settle = () => {
        if (e.settled) return;
        if (e.reject) {
          e.settled = true; outstanding--;
          if (e.reject.code === 'MESSAGE_OVERLOADED' && e.reject.retryable && e.reject.retryAfterMs > 0) {
            row.rejected++; const key = e.reject.code; row.rejectionCodes[key] = (row.rejectionCodes[key] || 0) + 1;
          } else row.errors['unexpected protocol rejection'] = (row.errors['unexpected protocol rejection'] || 0) + 1;
        } else if (e.ack && e.seen.size === e.expected) {
          e.settled = true; outstanding--; row.received++;
          row.ackLatencies.push(e.ack - e.began);
          const latency = Math.max(e.ack, e.lastReceipt) - e.began;
          row.deliveryLatencies.push(latency);
          (e.kind === 'group' ? row.groupLatencies : row.privateLatencies).push(latency);
        }
      };
      entries.set(id, e); outstanding++; row.attempted++;
      target.sender.ws.send(JSON.stringify({ content: id, clientMsgId: id, type: 'text' }));
    }
    let next = 0;
    const count = burst ? offeredRate : Math.floor(offeredRate * seconds);
    while (next < count) {
      const due = burst ? count : Math.min(count, Math.floor((performance.now() - start) / 1000 * offeredRate) + 1);
      while (next < due) {
        row.maxSchedulerLagMs = Math.max(row.maxSchedulerLagMs, burst ? 0 : performance.now() - start - next / offeredRate * 1000);
        if (outstanding >= 1000) row.generatorDropped++;
        else send(next);
        next++;
      }
      if (!burst) await sleep(5);
    }
    const stopped = performance.now();
    while (outstanding && performance.now() - stopped < 15000) await sleep(10);
    const receiptDrainMs = performance.now() - stopped;
    let audit = await backend.auditMessages();
    while (Number(audit.pendingOutbox) && performance.now() - stopped < 15000) {
      await sleep(50); audit = await backend.auditMessages();
    }
    const outboxDrainMs = performance.now() - stopped;
    const after = await scrape();
    row.accepted = [...entries.values()].filter(e => e.ack).length;
    const summary = { name, offeredRate, burst, offered: count, attempted: row.attempted,
      accepted: row.accepted, rejected: row.rejected, received: row.received,
      missingAcknowledgements: [...entries.values()].filter(e => !e.ack && !e.reject).length,
      missingAcceptedReceipts: [...entries.values()].filter(e => e.ack && e.seen.size !== e.expected).length,
      generatorDropped: row.generatorDropped, maxSchedulerLagMs: row.maxSchedulerLagMs,
      sendSeconds: (stopped - start) / 1000, receiptDrainMs, outboxDrainMs, audit,
      privateP95Ms: pct(row.privateLatencies, .95), groupP95Ms: pct(row.groupLatencies, .95),
      ackP95Ms: pct(row.ackLatencies, .95), deliveryP99Ms: pct(row.deliveryLatencies, .99),
      duplicates: row.duplicates, orderErrors: row.orderErrors, unexpectedCloses: row.unexpectedCloses,
      errors: row.errors, samplingErrors: row.samplingErrors, samples: row.samples,
      rejectionCounters: Object.fromEntries(['rate_limit', 'queue_full', 'outbox_pressure', 'pressure_unavailable', 'admission_unavailable'].map(k => [k,
        metric(after, `pomelo_message_rejected_${k}_total`) - metric(before, `pomelo_message_rejected_${k}_total`)])),
      generatorEventLoopP99Ms: loop.percentile(99) / 1e6 };
    summary.meetsLatencyTargets = (!summary.privateP95Ms || summary.privateP95Ms <= 500)
      && (!summary.groupP95Ms || summary.groupP95Ms <= 1000) && Math.max(receiptDrainMs, outboxDrainMs) <= 5000;
    summary.integrityPassed = !summary.generatorDropped && !summary.missingAcknowledgements && !summary.missingAcceptedReceipts
      && !row.duplicates && !row.orderErrors && !row.unexpectedCloses && !Object.keys(row.errors).length
      && !audit.sequenceErrors.length && !audit.statisticsErrors.length && !Number(audit.pendingOutbox);
    trial.phases.push(summary); console.log(JSON.stringify({ profile: profile.name, ...summary, samples: undefined }));
    current = undefined; await save(); await sleep(2500);
  }
  try {
    backend = await startChatBackend(process.cwd());
    const clients = await backend.createIndependentPeers(100, true), privatePeers = [];
    for (let i = 0; i < clients.length; i += 20)
      privatePeers.push(...await Promise.all(clients.slice(i, i + 20).map(async c => ({ a: await connect(c.auth, c.room.room), b: await connect(c.receiverAuth, c.room.room) }))));
    const groups = [];
    for (const [index, members] of [clients.slice(0, 50), clients.slice(50)].entries()) {
      const owner = members[0].auth;
      for (const c of members.slice(1)) await api('friend/add_friend', owner, { id: c.auth.info.id, username: c.auth.info.username });
      await api('group/create_group', owner, { name: `Calibration ${index}`, avatar: '', members: members.slice(1).map(c => ({ user_id: c.auth.info.id, username: c.auth.info.username })) });
      const group = (await api('group/group_list', owner)).find(g => g.name === `Calibration ${index}`);
      groups.push(await Promise.all(members.map(c => connect(c.auth, group.room, 'group'))));
    }
    loop.enable(); sampler = setInterval(() => void sample(), 1000);
    const privateRoute = i => ({ sender: privatePeers[i % 100].a, expected: 2, kind: 'private' });
    await phase('normal', 100, privateRoute);
    await phase('private-load', 700, privateRoute);
    await phase('hot-group', 200, i => ({ sender: groups[0][i % 50], expected: 50, kind: 'group' }));
    await phase('mixed', 340, i => {
      const slot = i % 17;
      if (slot < 5) return privateRoute(Math.floor(i / 17) * 5 + slot);
      const g = slot < 11 ? 0 : 1;
      return { sender: groups[g][(Math.floor(i / 17) * 6 + (slot - 5) % 6) % 50], expected: 50, kind: 'group' };
    });
    await phase('single-room-burst', 300, () => ({ sender: privatePeers[0].a, expected: 2, kind: 'private' }), true);
    await phase('global-burst', 400, privateRoute, true);
    trial.audit = await backend.auditMessages(); trial.completed = true;
    await writeFile(path.join(output, `${profile.name}-metrics.prom`), await scrape());
  } catch (error) { trial.completed = false; trial.fatal = error.message; console.error(`${profile.name}: ${error.stack}`); }
  finally {
    clearInterval(sampler); loop.disable(); current = undefined;
    for (const p of peers) { p.expectedClose = true; p.ws.terminate(); }
    if (backend) await backend.close();
    await save(); console.log(`END ${profile.name}`);
  }
}
console.log(`Report: ${output}`);
if (report.trials.some(t => !t.completed || t.phases.some(p => !p.integrityPassed))) process.exitCode = 1;
