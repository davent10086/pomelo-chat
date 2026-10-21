#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { main, allocatePort } = require('../tests/run.cjs');
const { stopTree, runProcess } = require('../tests/helpers/process.cjs');
const { repoRoot, serverRoot, serverRequire } = require('../tests/helpers/paths.cjs');

async function run() {
  if (!process.env.TEST_RUN_ID) return main(['qa']);
  const port = await allocatePort();
  const artifacts = process.env.TEST_ARTIFACT_DIR;
  const env = { ...process.env, PORT: String(port), QA_RUN_ID: process.env.TEST_RUN_ID,
    QA_RESULTS_DIR: artifacts, QA_RUN_LIVE_AI: 'false',
    QA_API_BASE: `http://127.0.0.1:${port}/api/chat/v1`, QA_WS_BASE: `ws://127.0.0.1:${port}/api/chat/v1`,
    MESSAGE_ROOM_QUEUE_MAX: '128', API_RATE_LIMIT_MAX: '10000', AUTH_IP_RATE_LIMIT_MAX: '10000', AUTH_ACCOUNT_RATE_LIMIT_MAX: '10000' };
  for (const name of ['MESSAGE_USER_RATE', 'MESSAGE_USER_BURST', 'MESSAGE_PRIVATE_RATE', 'MESSAGE_PRIVATE_BURST', 'MESSAGE_GROUP_RATE', 'MESSAGE_GROUP_BURST', 'MESSAGE_GLOBAL_RATE', 'MESSAGE_GLOBAL_BURST']) env[name] = '10000';
  const log = fs.createWriteStream(path.join(artifacts, 'server.log'));
  const server = spawn(process.execPath, ['-r', serverRequire.resolve('ts-node/register'), 'src/index.ts'],
    { cwd: serverRoot, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.pipe(log); server.stderr.pipe(log);
  let spawnError;
  server.on('error', error => { spawnError = error; });
  try {
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null) throw new Error('QA server exited before readiness; see server.log');
      const response = await fetch(`${env.QA_API_BASE}/ready`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
      if (response?.ok) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) throw new Error('QA server readiness timed out');
    const result = await runProcess(process.execPath, [path.join(repoRoot, 'qa/qa-full-test.js')],
      { cwd: repoRoot, env, logPath: path.join(artifacts, 'cases.log') });
    return result.status === 'passed' ? 0 : 1;
  } finally {
    await stopTree(server);
    await new Promise(resolve => log.end(resolve));
  }
}
run().then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
