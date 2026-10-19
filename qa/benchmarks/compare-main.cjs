/** Same public protocol and load against an immutable main snapshot and current drivers.
 * node qa/benchmarks/compare-main.cjs <main-snapshot-root> [seconds-per-phase=15]
 * Requires local MySQL/Redis. Creates and cleans only its own test resources.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:net');
const { randomUUID, createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const requireServer = createRequire(path.join(root, 'server/package.json'));
const mysql = requireServer('mysql2/promise'), Redis = requireServer('ioredis'), WS = requireServer('ws');
const mainRoot = path.resolve(process.argv[2] || 'missing');
const seconds = Number(process.argv[3] || 15);
const probeOnly = process.argv.includes('--revocation-only');
const optimization = process.argv.includes('--optimization');
const beforeRoot = process.env.COMPARE_BEFORE_ROOT && path.resolve(process.env.COMPARE_BEFORE_ROOT);
if (optimization) assert.ok(beforeRoot && fs.existsSync(path.join(beforeRoot, 'services/realtime/gateway.go')), 'Set COMPARE_BEFORE_ROOT to the preserved source snapshot');
assert.ok(fs.existsSync(path.join(mainRoot, 'server/src/index.ts')), 'Supply extracted main snapshot');
assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds <= 120);
const envFile = requireServer('dotenv').parse(fs.readFileSync(path.join(root, 'server/.env')));
const baseEnv = { ...envFile, ...process.env };
const directory = path.join(root, 'test-results', `${optimization ? 'go-optimization' : probeOnly ? 'main-revocation' : 'main-comparison'}-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true });
const binary = path.join(directory, 'realtime' + (process.platform === 'win32' ? '.exe' : ''));
const beforeBinary = path.join(directory, 'before-realtime' + (process.platform === 'win32' ? '.exe' : ''));
const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
const report = { startedAt: new Date().toISOString(), mainCommit: git(['rev-parse', 'main']),
  currentHead: git(['rev-parse', 'HEAD']), currentStatus: git(['status', '--short']),
  environment: { node: process.version, go: spawnSync('go', ['version'], { encoding: 'utf8' }).stdout.trim(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() },
  scope: (optimization ? 'Local serial before/after/after/before; both use 1 Node + 2 Go all processes. ' : 'Local serial ABCCBA; main and current-node: 2 Node processes; current-go: 1 Node + 2 Go all processes. ') + 'Default admission, 10 private pairs at 2 messages/s each; 10 distinct group recipients at 4 messages/s. One in-flight per sender, 128-byte payload plus identifier. Success-only latency with failures/missed slots reported. CPU excludes startup; RSS snapshots are not peaks. Shared dependencies, isolated data. Not capacity or HA proof.', secondsPerPhase: seconds, beforeRoot: optimization ? beforeRoot : undefined, runs: [] };
const save = () => fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, label, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(5); } throw Error(label); }
async function port() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const p = server.address().port; await new Promise(resolve => server.close(resolve)); return p; }
async function command(file, args, options) { const child = spawn(file, args, { stdio: 'inherit', ...options }); const [code] = await once(child, 'exit'); assert.equal(code, 0, `${file} failed`); }
function resources(children) {
  const ids = children.map(c => c.pid);
  if (process.platform !== 'win32') {
    const ticks = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim());
    assert.ok(ticks);
    return ids.reduce((sum, pid) => {
      const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      return { cpu: sum.cpu + (Number(fields[11]) + Number(fields[12])) / ticks, rss: sum.rss + Number(rss?.[1] || 0) * 1024 };
    }, { cpu: 0, rss: 0 });
  }
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${ids.join(',')} | Select-Object Id,CPU,WorkingSet64 | ConvertTo-Json -Compress`], { encoding: 'utf8' });
  assert.equal(result.status, 0); const rows = [].concat(JSON.parse(result.stdout.replace(/^\uFEFF/, '')));
  return { cpu: rows.reduce((sum, r) => sum + r.CPU, 0), rss: rows.reduce((sum, r) => sum + r.WorkingSet64, 0) };
}
function percentiles(values) { const sorted = [...values].sort((a, b) => a - b); return Object.fromEntries([.5, .95, .99].map(p => ['p' + p * 100, sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null])); }
async function trial(label, round) {
  const source = label === 'main' ? mainRoot : label === 'before-go' ? beforeRoot : root, go = label === 'current-go' || label === 'before-go';
  const id = randomUUID().replaceAll('-', ''), database = `pomelo_comparison_test_${id}`, prefix = `${database}:`;
  const uploads = path.join(directory, 'uploads-' + id); fs.mkdirSync(uploads);
  const admin = await mysql.createConnection({ host: baseEnv.DB_HOST || '127.0.0.1', port: Number(baseEnv.DB_PORT || 3306), user: baseEnv.DB_USER || 'root', password: baseEnv.DB_PASSWORD || '' });
  const redis = new Redis(baseEnv.REDIS_URL_TEST || 'redis://127.0.0.1:6379/15', { retryStrategy: () => null });
  const children = [], sockets = [], row = { label, round, checks: [], phases: [], error: null }; report.runs.push(row); save();
  let created = false;
  const url = new URL('mysql://localhost'); url.hostname = baseEnv.DB_HOST || '127.0.0.1'; url.port = String(baseEnv.DB_PORT || 3306); url.username = baseEnv.DB_USER || 'root'; url.password = baseEnv.DB_PASSWORD || ''; url.pathname = '/' + database;
  const env = { ...baseEnv, NODE_ENV: 'test', DATABASE_URL_TEST: url.href, REDIS_URL: baseEnv.REDIS_URL_TEST || 'redis://127.0.0.1:6379/15', REDIS_KEY_PREFIX: prefix,
    JWT_SECRET: randomUUID(), REALTIME_INTERNAL_TOKEN: randomUUID() + randomUUID(), REALTIME_DRIVER: go ? 'go' : 'node', OUTBOX_DRIVER: go ? 'go' : 'node', BIND_HOST: '127.0.0.1', UPLOAD_ROOT: uploads,
    API_RATE_LIMIT_MAX: '100000', METRICS_TOKEN: randomUUID(), REQUEST_LOGS: 'false', TS_NODE_FILES: 'true', AI_API_KEY: '', DASHSCOPE_API_KEY: '', DEEPSEEK_API_KEY: '', MCP_SERVERS_JSON: '[]', LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '',
    MESSAGE_USER_RATE: '5', MESSAGE_USER_BURST: '10', MESSAGE_PRIVATE_RATE: '10', MESSAGE_PRIVATE_BURST: '20', MESSAGE_GROUP_RATE: '20', MESSAGE_GROUP_BURST: '20', MESSAGE_GLOBAL_RATE: '150', MESSAGE_GLOBAL_BURST: '100',
    MESSAGE_ROOM_QUEUE_MAX: '32', MESSAGE_WRITE_QUEUE_MAX: '256', MESSAGE_OUTBOX_MAX_PENDING: '500', MESSAGE_OUTBOX_ROOM_MAX_PENDING: '40', MESSAGE_OUTBOX_MAX_AGE_SECONDS: '3' };
  async function launch(file, args, extra, address, health) {
    const child = spawn(file, args, { cwd: path.join(source, 'server'), env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    const log = fs.createWriteStream(path.join(directory, `${label}-${round}-${children.length}.log`)); child.stdout.pipe(log); child.stderr.pipe(log);
    await wait(async () => { if (child.exitCode !== null) throw Error('Service exited, see logs'); try { const response = await fetch(address + health, { signal: AbortSignal.timeout(1000) }); return response.ok || (label === 'main' && response.status === 404); } catch { return false; } }, 'Service startup timeout', 60000); return child;
  }
  async function api(base, route, auth, body) {
    const res = await fetch(base + '/api/chat/v1/' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth.token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const json = await res.json(); assert.equal(json.code, 200, route + ':' + JSON.stringify(json)); return json.data;
  }
  async function connect(base, auth, room, type = 'private') {
    const ws = new WS(base.replace('http:', 'ws:') + `/api/chat/v1/message/connect_chat?room=${room}&type=${type}&id=${auth.info.id}`, ['pomelo-token', auth.token]); sockets.push(ws);
    const p = { ws, frames: [], ack: new Map(), seen: new Map(), duplicates: 0, orderErrors: 0, lastSeq: 0 };
    ws.on('error', () => {}); ws.on('message', raw => { const f = JSON.parse(raw); const at = performance.now(); p.frames.push(f);
      if (f.name === 'ack' || f.name === 'error') p.ack.set(f.client_msg_id, { ...f, at });
      else if (f.id) { if (p.seen.has(f.id)) p.duplicates++; else { if (f.room_seq <= p.lastSeq) p.orderErrors++; p.lastSeq = f.room_seq; p.seen.set(f.id, { frame: f, at }); } if (f.receipt) ws.send(JSON.stringify({ name: 'delivery_ack', receipt: f.receipt })); }
    }); await wait(() => p.frames.some(f => f.name === 'history'), 'History timeout'); return p;
  }
  async function send(peer, receivers, content, clientMsgId = randomUUID()) {
    peer.ack.delete(clientMsgId); const at = performance.now(); peer.ws.send(JSON.stringify({ content, type: 'text', clientMsgId }));
    const ack = await wait(() => peer.ack.get(clientMsgId), 'ACK timeout'); assert.equal(ack.name, 'ack', JSON.stringify(ack));
    await wait(() => receivers.every(p => p.seen.has(ack.id)), 'Recipient timeout');
    return { ack, ackMs: ack.at - at, receiveMs: Math.max(...receivers.map(p => p.seen.get(ack.id).at)) - at };
  }
  try {
    await admin.query('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [database]); created = true;
    const bases = [], p = await port(), nodeBase = `http://127.0.0.1:${p}`;
    await launch(process.execPath, ['-r', requireServer.resolve('ts-node/register/transpile-only'), 'src/index.ts'], { PORT: String(p) }, nodeBase, '/api/chat/v1/health');
    if (!go) { bases.push(nodeBase); const p2 = await port(), b2 = `http://127.0.0.1:${p2}`; await launch(process.execPath, ['-r', requireServer.resolve('ts-node/register/transpile-only'), 'src/index.ts'], { PORT: String(p2) }, b2, '/api/chat/v1/health'); bases.push(b2); }
    else for (let i = 0; i < 2; i++) { const pg = await port(), bg = `http://127.0.0.1:${pg}`; await launch(label === 'before-go' ? beforeBinary : binary, ['-role', 'all'], { NODE_INTERNAL_URL: nodeBase, GO_REALTIME_ADDR: `127.0.0.1:${pg}` }, bg, '/internal/ready'); bases.push(bg); }
    const bcrypt = requireServer('bcrypt'), password = 'ComparisonTest123!', hash = await bcrypt.hash(password, 10), auths = [];
    for (let i = 0; i < 20; i++) { const username = `compare_${i}`;
      await admin.query('INSERT INTO ??.user (username,password,phone,avatar,name) VALUES (?,?,?,?,?)', [database, username, hash, '139' + String(i).padStart(8, '0'), '', username]);
      await admin.query('INSERT INTO ??.friend_group (user_id,username,name) SELECT id,username,? FROM ??.user WHERE username=?', [database, '我的好友', database, username]);
      auths.push(await api(bases[0], 'auth/login', null, { username, password })); }
    const jobs = [];
    for (let i = 0; i < 10; i++) { const a = auths[i * 2], b = auths[i * 2 + 1]; await api(bases[0], 'friend/add_friend', a, { id: b.info.id, username: b.info.username });
      const room = (await api(bases[0], 'message/chat_list', a)).find(r => Number(r.receiver_id) === b.info.id).room;
      jobs.push({ room, a, b, sender: await connect(bases[0], a, room), receivers: [await connect(bases[1], b, room)] }); }
    const owner = auths[0], members = auths.filter((_, i) => i % 2 === 1);
    for (const b of members.slice(1)) await api(bases[0], 'friend/add_friend', owner, { id: b.info.id, username: b.info.username });
    await api(bases[0], 'group/create_group', owner, { name: 'Compare main group', members: members.map(b => ({ user_id: b.info.id, username: b.info.username })) });
    const [[group]] = await admin.query('SELECT room FROM ??.group_chat WHERE creator_id=?', [database, owner.info.id]);
    const groupJob = { sender: await connect(bases[0], owner, group.room, 'group'), receivers: [] };
    for (let i = 0; i < members.length; i++) groupJob.receivers.push(await connect(bases[i % 2], members[i], group.room, 'group'));
    const first = jobs[0], key = 'idempotence-' + id;
    const original = await send(first.sender, first.receivers, 'same content', key), repeated = await send(first.sender, first.receivers, 'same content', key); assert.equal(original.ack.id, repeated.ack.id);
    first.sender.ack.delete(key); first.sender.ws.send(JSON.stringify({ content: 'different content', type: 'text', clientMsgId: key })); assert.equal((await wait(() => first.sender.ack.get(key), 'Conflict timeout')).name, 'error');
    const [[count]] = await admin.query('SELECT COUNT(*) AS n FROM ??.message WHERE sender_id=? AND client_msg_id=?', [database, first.a.info.id, key]); assert.equal(count.n, 1); row.checks.push('idempotent retry and conflicting retry');
    const history = await api(bases[1], `message/history?room=${first.room}&type=private`, first.b); assert.ok(history.messages.some(m => m.id === original.ack.id)); row.checks.push('history contains committed message');
    async function phase(name, phaseJobs, gap) {
      for (const job of phaseJobs) await send(job.sender, job.receivers, 'warmup-' + randomUUID());
      const metrics = async () => {
        const values = {};
        if (go) for (const base of bases) {
          const response = await fetch(base + '/internal/metrics', { headers: { Authorization: 'Bearer ' + env.METRICS_TOKEN }, signal: AbortSignal.timeout(3000) }); assert.ok(response.ok);
          for (const line of (await response.text()).split('\n')) { const match = /^(pomelo_(?:(?:bridge_\w+|socket_queue_wait)_seconds_(?:count|sum)|outbox_(?:claim|empty)_scans_total)) ([\d.e+-]+)$/.exec(line); if (match) values[match[1]] = (values[match[1]] || 0) + Number(match[2]); }
        }
        return values;
      };
      const metricsBefore = await metrics();
      await sleep(1000); const before = resources(children), ackTimes = [], receiveTimes = [], errors = [], started = performance.now(), end = started + seconds * 1000;
      let attempts = 0, success = 0, skipped = 0;
      await Promise.all(phaseJobs.map(async job => { let slot = 0; while (started + slot * gap < end) { const scheduled = started + slot++ * gap; await sleep(Math.max(0, scheduled - performance.now())); if (performance.now() >= end) { skipped++; continue; } attempts++;
        try { const measured = await send(job.sender, job.receivers, 'x'.repeat(128) + randomUUID()); ackTimes.push(measured.ackMs); receiveTimes.push(measured.receiveMs); success++; } catch (error) { errors.push(error.message); } } }));
      const elapsed = (performance.now() - started) / 1000, after = resources(children);
      const metricsAfter = await metrics(), metricsDelta = Object.fromEntries(Object.entries(metricsAfter).map(([key, value]) => [key, value - (metricsBefore[key] || 0)]));
      row.phases.push({ name, scheduled: phaseJobs.length * Math.ceil(seconds * 1000 / gap), attempts, success, skipped, errors, recipientsPerMessage: phaseJobs[0].receivers.length, elapsedSeconds: elapsed, acceptedPerSecond: success / elapsed, ack: percentiles(ackTimes), receive: percentiles(receiveTimes), cpuSeconds: after.cpu - before.cpu, rssBytes: after.rss, metricsDelta }); save();
      assert.equal(errors.length, 0); assert.equal(skipped, 0); console.log(`[compare-main] ${label} round ${round} ${name} accepted=${success} receiveP95=${percentiles(receiveTimes).p95.toFixed(2)}ms`);
    }
    if (!probeOnly) { await phase('private', jobs, 500); await phase('group', [groupJob], 250); }
    // Deliberately bypass the control notification: the delivery path must enforce
    // authoritative membership even if a revocation event is lost.
    const [[groupRow]] = await admin.query('SELECT id FROM ??.group_chat WHERE room=?', [database, group.room]);
    await admin.query('DELETE FROM ??.group_members WHERE group_id=? AND user_id=?', [database, groupRow.id, members[0].info.id]);
    const revoked = groupJob.receivers[0];
    const postRevoke = await send(groupJob.sender, groupJob.receivers.slice(1), 'after-authoritative-revocation-' + id);
    await sleep(500);
    row.revocation = { controlEventSent: false, removedMemberReceived: revoked.seen.has(postRevoke.ack.id), removedSocketClosed: revoked.ws.readyState === WS.CLOSED };
    if (label !== 'main') { assert.equal(row.revocation.removedMemberReceived, false); await wait(() => revoked.ws.readyState === WS.CLOSED, 'Revoked socket remained open'); row.revocation.removedSocketClosed = true; }
    await wait(async () => { const [[r]] = await admin.query('SELECT COUNT(*) AS n FROM ??.message_outbox WHERE delivered_at IS NULL', [database]); return !r.n; }, 'Outbox drain timeout');
    const [seq] = await admin.query('SELECT room FROM ??.message GROUP BY room HAVING MIN(room_seq)<>1 OR MAX(room_seq)<>COUNT(*) OR COUNT(DISTINCT room_seq)<>COUNT(*)', [database]); assert.equal(seq.length, 0);
    const [stats] = await admin.query('SELECT s.room FROM ??.message_statistics s LEFT JOIN ??.message m ON m.room=s.room GROUP BY s.room,s.total HAVING s.total<>COUNT(m.id)', [database, database]); assert.equal(stats.length, 0);
    assert.ok([...jobs.flatMap(j => [j.sender, ...j.receivers]), groupJob.sender, ...groupJob.receivers].every(p => !p.orderErrors && !p.duplicates));
    row.checks.push('every accepted message received', 'live order and duplicate checks', 'contiguous database sequences', 'message statistics match rows', 'outbox fully drained');
  } catch (error) { row.error = error.stack; throw error; }
  finally {
    save(); for (const socket of sockets) socket.terminate();
    for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    try { let cursor = '0'; do { const [next, keys] = await redis.scan(cursor, 'MATCH', prefix + '*', 'COUNT', 200); cursor = next; if (keys.length) await redis.del(...keys); } while (cursor !== '0'); } finally { redis.disconnect(); }
    if (created && /^pomelo_comparison_test_[a-f0-9]{32}$/.test(database)) await admin.query('DROP DATABASE ??', [database]); await admin.end();
    assert.equal(path.dirname(uploads), directory); fs.rmSync(uploads, { recursive: true, force: true });
  }
}
(async () => {
  await command('go', ['build', '-o', binary, '.'], { cwd: path.join(root, 'services/realtime') });
  if (optimization) await command('go', ['build', '-o', beforeBinary, '.'], { cwd: path.join(beforeRoot, 'services/realtime') });
  report.mainSourceSha256 = createHash('sha256').update(fs.readFileSync(path.join(mainRoot, 'server/src/modules/messaging/writes.ts'))).digest('hex');
  const order = optimization ? ['before-go', 'current-go', 'current-go', 'before-go'] : probeOnly ? ['main', 'current-node', 'current-go'] : ['main', 'current-node', 'current-go', 'current-go', 'current-node', 'main'];
  for (const [index, label] of order.entries()) await trial(label, optimization ? index < 2 ? 1 : 2 : index < 3 ? 1 : 2);
  report.completed = true; save(); console.log('Report: ' + path.join(directory, 'report.json'));
})().catch(error => { report.completed = false; report.error = error.stack; save(); console.error(error); process.exitCode = 1; });
