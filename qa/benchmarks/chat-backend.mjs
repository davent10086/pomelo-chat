import { createRequire } from 'node:module';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function startChatBackend(root, options = {}) {
  const instanceCount = Number(options.instances || process.env.BENCH_INSTANCES || 1);
  if (!Number.isInteger(instanceCount) || instanceCount < 1 || instanceCount > 4) throw new Error('BENCH_INSTANCES must be 1..4');
  const serverRoot = path.join(root, 'server');
  const require = createRequire(path.join(serverRoot, 'package.json'));
  const dotenv = require('dotenv');
  let fileEnv = {};
  try { fileEnv = dotenv.parse(await readFile(path.join(serverRoot, '.env'))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const env = { ...fileEnv, ...process.env };
  const mysql = require('mysql2/promise');
  const Redis = require('ioredis');
  const admin = await mysql.createConnection({ host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306), user: env.DB_USER || 'root', password: env.DB_PASSWORD || '' });
  const id = randomUUID().replaceAll('-', '');
  const database = `pomelo_benchmark_test_${id}`;
  const prefix = `benchmark:${id}:`;
  const uploadParent = path.join(root, 'tmp', 'benchmark-uploads');
  await mkdir(uploadParent, { recursive: true });
  const uploadRoot = await mkdtemp(path.join(uploadParent, 'run-'));
  const redis = new Redis(env.REDIS_URL_TEST || env.REDIS_URL || { host: env.REDIS_HOST || '127.0.0.1', port: Number(env.REDIS_PORT || 6379), password: env.REDIS_PASSWORD || undefined, db: Number(env.REDIS_DB || 0) }, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const messageErrorTypes = {};
  let child;
  const instances = [];
  const jwtSecret = randomUUID();
  let created = false;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const instance of instances) if (instance.child && instance.child.exitCode === null && instance.child.signalCode === null)
      await new Promise(resolve => { instance.child.once('exit', resolve); instance.child.kill(); });
    try {
      if (redis.status === 'ready') {
        let cursor = '0';
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
          cursor = next;
          if (keys.length) await redis.del(...keys);
        } while (cursor !== '0');
      }
    } finally {
      redis.disconnect();
      // Cleanup is restricted to the exact database created by this invocation.
      if (created && /^pomelo_benchmark_test_[a-f0-9]{32}$/.test(database)) await admin.query('DROP DATABASE ??', [database]);
      await admin.end();
      if (path.dirname(uploadRoot) !== uploadParent || !path.basename(uploadRoot).startsWith('run-')) throw new Error('Unsafe benchmark upload cleanup');
      await rm(uploadRoot, { recursive: true, force: true });
    }
  }
  try {
    await redis.connect();
    await redis.ping();
    await admin.query('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [database]);
    created = true;
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const url = new URL('mysql://localhost');
    url.hostname = env.DB_HOST || '127.0.0.1';
    url.port = String(env.DB_PORT || 3306);
    url.username = env.DB_USER || 'root';
    url.password = env.DB_PASSWORD || '';
    url.pathname = '/' + database;
    async function launchInstance(index, instancePort) {
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const timer = setTimeout(() => readyReject(new Error('Isolated backend startup timed out')), 60000);
    const redisTarget = env.REDIS_URL_TEST || env.REDIS_URL;
    const instance = instances[index] || { index, port: instancePort, base: `http://127.0.0.1:${instancePort}`, logs: '' };
    const processChild = spawn(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), ...(env.BENCH_DIAGNOSTIC_PRELOAD ? ['-r', env.BENCH_DIAGNOSTIC_PRELOAD] : []), 'src/index.ts'], {
      cwd: serverRoot,
      env: { ...env, NODE_ENV: 'test', PORT: String(instancePort), DATABASE_URL_TEST: url.href, REDIS_KEY_PREFIX: prefix, UPLOAD_ROOT: uploadRoot,
        ...(redisTarget ? { REDIS_URL: redisTarget } : {}), JWT_SECRET: jwtSecret, TS_NODE_FILES: 'true', REQUEST_LOGS: 'false',
        AI_API_KEY: '', DASHSCOPE_API_KEY: '', DEEPSEEK_API_KEY: '', MCP_SERVERS_JSON: '[]', LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '' },
      stdio: ['ignore', 'pipe', 'pipe', ...(env.BENCH_DIAGNOSTIC_PRELOAD ? ['ipc'] : [])]
    });
    instance.child = processChild; instance.pid = processChild.pid; instances[index] = instance;
    processChild.stdout.on('data', data => { instance.logs += data.toString(); if (data.toString().includes('Server listening')) readyResolve(); });
    processChild.stderr.on('data', data => { instance.logs += data.toString(); const text = data.toString(); if (text.includes('[message] ws message error:')) { const kind = /deadlock/i.test(text) ? 'database_deadlock' : /lock wait timeout/i.test(text) ? 'database_lock_timeout' : /duplicate/i.test(text) ? 'database_duplicate' : /pool|connection/i.test(text) ? 'database_connection' : 'other_message_error'; messageErrorTypes[kind] = (messageErrorTypes[kind] || 0) + (text.match(/\[message\] ws message error:/g) || []).length; } if (/服务启动失败/.test(data.toString())) readyReject(new Error('Backend startup failed; check local MySQL/Redis configuration')); });
    processChild.once('error', readyReject);
    processChild.once('exit', code => readyReject(new Error(`Backend exited (${code})`)));
    try { await ready; } finally { clearTimeout(timer); }
    return instance;
    }
    child = (await launchInstance(0, port)).child;
    for (let index = 1; index < instanceCount; index++) {
      const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
      const nextPort = socket.address().port; await new Promise(resolve => socket.close(resolve));
      await launchInstance(index, nextPort);
    }
    async function stopInstance(index) {
      const target = instances[index].child;
      if (target.exitCode === null && target.signalCode === null) await new Promise(resolve => { target.once('exit', resolve); target.kill(); });
    }
    async function restartInstance(index) { await stopInstance(index); return launchInstance(index, instances[index].port); }
    async function controlInstance(index, command) {
      const target = instances[index].child, requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const listener = message => { if (message.requestId === requestId) { clearTimeout(timer); target.off('message', listener); message.error ? reject(new Error(message.error)) : resolve(message.result); } };
        const timer = setTimeout(() => { target.off('message', listener); reject(new Error('Diagnostic command timed out')); }, 10000);
        target.on('message', listener); target.send({ ...command, requestId });
      });
    }
    const base = `http://127.0.0.1:${port}`;
    const password = 'BenchmarkOnly123!';
    const api = async (route, body, token) => {
      const response = await fetch(`${base}/api/chat/v1/${route}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      if (!response.ok || result.code !== 200) throw new Error(`Fixture API ${route} failed (${response.status}, ${result.code})`);
      return result.data;
    };
    // Seed users cheaply, then exercise real login, friend APIs and message persistence.
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(password, 10);
    const names = Array.from({ length: 11 }, (_, i) => `bench_user_${i}`);
    for (let i = 0; i < names.length; i++) {
      await admin.query('INSERT INTO ??.user (username, password, phone, avatar, name) VALUES (?, ?, ?, ?, ?)', [database, names[i], hash, `1390000${String(i).padStart(4, '0')}`, '', i === 0 ? 'Benchmark User' : `Benchmark Contact ${i}`]);
      await admin.query('INSERT INTO ??.friend_group (user_id, username, name) SELECT id, username, ? FROM ??.user WHERE username = ?', [database, '我的好友', database, names[i]]);
    }
    const auth = await api('auth/login', { username: names[0], password });
    const [peers] = await admin.query('SELECT id, username FROM ??.user WHERE username <> ? ORDER BY id', [database, names[0]]);
    for (const peer of peers) await api('friend/add_friend', { id: peer.id, username: peer.username }, auth.token);
    const rooms = await api('message/chat_list', undefined, auth.token);
    if (rooms.length !== 10) throw new Error(`Expected 10 fixture conversations, got ${rooms.length}`);
    const selected = rooms[0];
    const WebSocket = require('ws');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/chat/v1/message/connect_chat?room=${encodeURIComponent(selected.room)}&id=${auth.info.id}&type=private`, ['pomelo-token', auth.token]);
      // Seed below admission budgets; fixture traffic is outside measured phases.
      const fixtureGap = Math.ceil(1100 / Math.min(
        Number(env.MESSAGE_USER_RATE || 5), Number(env.MESSAGE_PRIVATE_RATE || 10), Number(env.MESSAGE_GLOBAL_RATE || 250)));
      const timeout = setTimeout(() => { ws.close(); reject(new Error('Fixture message seeding timed out')); }, 30000 + fixtureGap * 120);
      let nextSend;
      ws.once('close', () => clearTimeout(nextSend));
      let sent = 0;
      const send = () => { sent++; ws.send(JSON.stringify({ sender_id: auth.info.id, receiver_id: selected.receiver_id, content: `benchmark-message-${String(sent).padStart(3, '0')}`, type: 'text', clientMsgId: `benchmark-${id}-${sent}` })); };
      ws.on('message', raw => {
        const frame = JSON.parse(raw.toString());
        if (frame.name === 'history' && sent === 0) send();
        else if (frame.name === 'ack') { if (sent === 60) { clearTimeout(timeout); ws.close(); resolve(); } else nextSend = setTimeout(send, fixtureGap); }
        else if (frame.name === 'error') { clearTimeout(timeout); ws.close(); reject(new Error('Fixture message rejected')); }
      });
      ws.on('error', error => { clearTimeout(timeout); reject(error); });
    });
    // Extra fixtures are created only inside this invocation's temporary database.
    let nextPeerId = 0;
    async function createIndependentPeers(count, includeReceivers = false) {
      const clients = [];
      for (let pairIndex = 0; pairIndex < count; pairIndex++) {
        const i = nextPeerId++;
        const pair = [];
        for (const side of ['sender', 'receiver']) {
          const username = 'load_' + side + '_' + i;
          await admin.query('INSERT INTO ??.user (username, password, phone, avatar, name) VALUES (?, ?, ?, ?, ?)', [database, username, hash, '138' + String(i * 2 + pair.length).padStart(8, '0'), '', username]);
          await admin.query('INSERT INTO ??.friend_group (user_id, username, name) SELECT id, username, ? FROM ??.user WHERE username = ?', [database, '我的好友', database, username]);
          const [records] = await admin.query('SELECT id, username FROM ??.user WHERE username = ?', [database, username]);
          pair.push(records[0]);
        }
        const session = await api('auth/login', { username: pair[0].username, password });
        await api('friend/add_friend', pair[1], session.token);
        const conversations = await api('message/chat_list', undefined, session.token);
        if (conversations.length !== 1) throw new Error('Expected one independent room');
        const receiverAuth = includeReceivers ? await api('auth/login', { username: pair[1].username, password }) : undefined;
        clients.push({ auth: session, receiverAuth, room: conversations[0] });
      }
      return clients;
    }
    async function probeDatabase() {
      await admin.query('CREATE TABLE ??.benchmark_probe (id BIGINT AUTO_INCREMENT PRIMARY KEY, payload VARCHAR(64)) ENGINE=InnoDB', [database]);
      const pool = mysql.createPool({ host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306), user: env.DB_USER || 'root', password: env.DB_PASSWORD || '', database, connectionLimit: 10 });
      const results = [];
      try {
        for (const mode of ['select', 'autocommit-insert', 'transaction-insert']) {
          let count=0, errors=0; const start=performance.now(), until=start+8000;
          await Promise.all(Array.from({length:10},async()=>{const connection=await pool.getConnection();try{while(performance.now()<until){try{if(mode==='select') await connection.query('SELECT 1');else if(mode==='autocommit-insert')await connection.query('INSERT INTO benchmark_probe (payload) VALUES (?)',['probe']);else {await connection.beginTransaction();await connection.query('INSERT INTO benchmark_probe (payload) VALUES (?)',['probe']);await connection.commit();}count++;}catch(e){errors++;await connection.rollback();}}}finally{connection.release();}}));
          results.push({mode,concurrency:10,count,errors,perSecond:count/((performance.now()-start)/1000)});
        }
      } finally { await pool.end(); }
      return results;
    }
    async function databaseDiagnostics() {
      const [status] = await admin.query('SHOW ENGINE INNODB STATUS');
      const raw = status[0]?.Status || '';
      const start = raw.indexOf('LATEST DETECTED DEADLOCK');
      const end = raw.indexOf('TRANSACTIONS', start);
      const deadlock = start >= 0 ? raw.slice(start, end > start ? end : start + 16000) : '';
      const [indexes] = await admin.query('SHOW INDEX FROM ??.message', [database]);
      return { deadlock: deadlock.includes(database) ? deadlock : 'No latest deadlock belonging to this test database', indexes: indexes.map(row => ({ name: row.Key_name, column: row.Column_name, unique: !row.Non_unique })) };
    }
    async function auditMessages() {
      const [counts] = await admin.query('SELECT COUNT(*) AS messages FROM ??.message', [database]);
      const [sequenceErrors] = await admin.query('SELECT room, COUNT(*) AS total, COUNT(DISTINCT room_seq) AS distinct_seq, MIN(room_seq) AS first_seq, MAX(room_seq) AS last_seq FROM ??.message GROUP BY room HAVING first_seq <> 1 OR last_seq <> total OR distinct_seq <> total', [database]);
      const [statisticsErrors] = await admin.query('SELECT s.room, s.total, COUNT(m.id) AS actual FROM ??.message_statistics s LEFT JOIN ??.message m ON m.room=s.room GROUP BY s.room,s.total HAVING s.total <> COUNT(m.id)', [database,database]);
      const [outbox] = await admin.query('SELECT COUNT(*) AS pending FROM ??.message_outbox WHERE delivered_at IS NULL', [database]);
      return { ...counts[0], sequenceErrors, statisticsErrors, pendingOutbox: outbox[0].pending };
    }
    const [version] = await admin.query('SELECT VERSION() AS version');
    // Revocation regression helper; admin is connected only to this invocation's temporary DB.
    async function revokeRoomAccess(userId, room, type = 'private') {
      if (type === 'private') await admin.query('DELETE FROM ??.friend WHERE room=? AND group_id IN (SELECT id FROM ??.friend_group WHERE user_id=?)', [database, room, database, userId]);
      else if (type === 'group') await admin.query('DELETE FROM ??.group_members WHERE user_id=? AND group_id IN (SELECT id FROM ??.group_chat WHERE room=?)', [database, userId, database, room]);
      else throw new Error('Invalid test room type');
    }
    return { backendPid: child.pid, instances, stopInstance, restartInstance, controlInstance, revokeRoomAccess,
      versions: { mysql: version[0].version, redis: /redis_version:([^\r\n]+)/.exec(await redis.info('server'))?.[1] },
      auditMessages, probeDatabase, databaseDiagnostics, messageErrorTypes, createIndependentPeers, base, auth, rooms, selectedRoom: selected.room, dataset: { users: 11, privateConversations: 10, selectedConversationMessages: 60, lastMessage: 'benchmark-message-060' }, close };
  } catch (error) { await close(); throw error; }
}
