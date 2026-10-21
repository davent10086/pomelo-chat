// @tags performance http
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { serverRequire } = require('../../helpers/paths.cjs');
serverRequire('ts-node/register/transpile-only');
const { initDatabase, closeDatabase } = require('../../../server/src/infrastructure/database');
const { better_chat } = require('../../../server/src/infrastructure/redis');
const { default: app, registerAppRoutes } = require('../../../server/src/controller/app');

test('bounded real-service conversation-list latency baseline', { timeout: 60000 }, async () => {
  let server;
  try {
    await initDatabase();
    server = http.createServer(app); serverRequire('express-ws')(app, server); registerAppRoutes();
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/chat/v1`;
    const username = `perf_${randomUUID().slice(0, 12)}`, password = 'Performance123!';
    const call = async (route, body, token) => {
      const result = await fetch(base + route, { method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
      const value = await result.json(); assert.equal(result.status, 200); assert.equal(value.code, 200); return value.data;
    };
    await call('/auth/register', { username, password, phone: '139' + String(Date.now()).slice(-8), avatar: '' });
    const { token } = await call('/auth/login', { username, password });
    for (let index = 0; index < 10; index++) await call('/message/chat_list', undefined, token);
    const values = [], began = performance.now();
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let index = 0; index < 25; index++) {
        const before = performance.now(); await call('/message/chat_list', undefined, token); values.push(performance.now() - before);
      }
    }));
    values.sort((a, b) => a - b);
    const result = { requests: values.length, concurrency: 4, durationMs: performance.now() - began,
      p50Ms: values[Math.ceil(values.length * .5) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1],
      scope: 'single-user conversation-list baseline; not a capacity or SFU benchmark' };
    const budget = Number(process.env.TEST_PERF_P95_MS || 2000);
    assert.ok(Number.isFinite(budget) && budget > 0, 'TEST_PERF_P95_MS must be positive');
    await fs.writeFile(path.join(process.env.TEST_ARTIFACT_DIR, 'latency.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result)); assert.ok(result.p95Ms <= budget, `p95 ${result.p95Ms}ms exceeds budget ${budget}ms`);
  } finally {
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    better_chat.disconnect(); await closeDatabase();
  }
});
