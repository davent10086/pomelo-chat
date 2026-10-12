import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function startChatBackend(root) {
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
  const redis = new Redis(env.REDIS_URL_TEST || env.REDIS_URL || { host: env.REDIS_HOST || '127.0.0.1', port: Number(env.REDIS_PORT || 6379), password: env.REDIS_PASSWORD || undefined, db: Number(env.REDIS_DB || 0) }, { lazyConnect: true, maxRetriesPerRequest: 1 });
  let child;
  let created = false;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (child && child.exitCode === null) {
      await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    }
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
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const timer = setTimeout(() => readyReject(new Error('Isolated backend startup timed out')), 60000);
    const redisTarget = env.REDIS_URL_TEST || env.REDIS_URL;
    child = spawn(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), 'src/index.ts'], {
      cwd: serverRoot,
      env: { ...env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL_TEST: url.href, REDIS_KEY_PREFIX: prefix,
        ...(redisTarget ? { REDIS_URL: redisTarget } : {}), JWT_SECRET: randomUUID(), TS_NODE_FILES: 'true', REQUEST_LOGS: 'false',
        DEEPSEEK_API_KEY: '', MCP_SERVERS_JSON: '[]', LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', data => { if (data.toString().includes('Server listening')) readyResolve(); });
    child.stderr.on('data', data => { if (/服务启动失败/.test(data.toString())) readyReject(new Error('Backend startup failed; check local MySQL/Redis configuration')); });
    child.once('error', readyReject);
    child.once('exit', code => readyReject(new Error(`Backend exited (${code})`)));
    try { await ready; } finally { clearTimeout(timer); }
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
      const timeout = setTimeout(() => { ws.close(); reject(new Error('Fixture message seeding timed out')); }, 30000);
      let sent = 0;
      const send = () => { sent++; ws.send(JSON.stringify({ sender_id: auth.info.id, receiver_id: selected.receiver_id, content: `benchmark-message-${String(sent).padStart(3, '0')}`, type: 'text', clientMsgId: `benchmark-${id}-${sent}` })); };
      ws.on('message', raw => {
        const frame = JSON.parse(raw.toString());
        if (frame.name === 'history' && sent === 0) send();
        else if (frame.name === 'ack') { if (sent === 60) { clearTimeout(timeout); ws.close(); resolve(); } else send(); }
        else if (frame.name === 'error') { clearTimeout(timeout); ws.close(); reject(new Error('Fixture message rejected')); }
      });
      ws.on('error', error => { clearTimeout(timeout); reject(error); });
    });
    return { base, auth, rooms, selectedRoom: selected.room, dataset: { users: 11, privateConversations: 10, selectedConversationMessages: 60, lastMessage: 'benchmark-message-060' }, close };
  } catch (error) { await close(); throw error; }
}
