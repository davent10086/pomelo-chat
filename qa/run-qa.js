#!/usr/bin/env node
/* eslint-disable no-console */
const { spawn } = require('node:child_process');
const { mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const databaseUrl = process.env.DATABASE_URL_TEST || process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL_TEST;
if (!databaseUrl || !redisUrl) throw new Error('DATABASE_URL_TEST and REDIS_URL_TEST are required');
if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') throw new Error('QA cannot run in production');
const database = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
if (!/(^|[_-])test([_-]|$)|[_-]test$/i.test(database)) throw new Error(`Refusing non-test database: ${database}`);

const runId = `qa_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomUUID().slice(0, 8)}`;
const artifactDir = path.join(process.cwd(), 'tmp', 'qa', runId);
mkdirSync(artifactDir, { recursive: true });
const env = {
  ...process.env,
  NODE_ENV: 'test',
  APP_ENV: 'test',
  DATABASE_URL_TEST: databaseUrl,
  REDIS_URL: redisUrl,
  REDIS_KEY_PREFIX: `test:${runId}:`,
  QA_RUN_ID: runId,
  QA_RESULTS_DIR: artifactDir,
  PORT: '3100',
  QA_API_BASE: 'http://127.0.0.1:3100/api/chat/v1',
  QA_WS_BASE: 'ws://127.0.0.1:3100/api/chat/v1'
};
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: process.cwd(), env, stdio: options.stdio || 'inherit', shell: process.platform === 'win32' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  options.onChild?.(child);
});
const waitForServer = async () => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${env.QA_API_BASE}/assistant/agent/tools`);
      if (response.status === 200 || response.status === 401) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('QA server did not become ready within 30 seconds');
};

(async () => {
  let server;
  try {
    server = spawn('pnpm', ['--filter', 'pomelo-chat-server', 'exec', 'ts-node', '--files', 'src/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    const log = require('node:fs').createWriteStream(path.join(artifactDir, 'server.log'));
    server.stdout.pipe(log); server.stderr.pipe(log);
    await waitForServer();
    await run(process.execPath, ['qa/qa-full-test.js']);
  } finally {
    if (server && !server.killed) server.kill();
    await run(process.execPath, ['qa/cleanup-qa-data.js']).catch(error => console.error('[qa-cleanup] failed:', error.message));
    console.log(`[qa] artifacts: ${artifactDir}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
