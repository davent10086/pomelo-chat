// Sequential, isolated evidence collection. Never run load phases in parallel.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startChatBackend } from './chat-backend.mjs';

const root = process.cwd();
const id = `orm-go-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const output = path.join(root, 'test-results', id);
const steps = [];
await mkdir(output, { recursive: true });
async function save() {
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ id, date: new Date().toISOString(),
    node: process.version, cpu: os.cpus()[0].model, logicalCpus: os.cpus().length,
    memoryGiB: os.totalmem() / 2 ** 30, steps,
    limitations: 'Local loopback, shared hardware, closed-loop, successful-operation percentiles. Profiling adds overhead. Pool trials are single runs in fixed order, not proof of an optimal pool size. No ORM or Go implementation benchmarked. No paid AI or real media load.' }, null, 2));
}
async function run(name, script, args = [], extraEnv = {}) {
  const start = Date.now();
  console.log(`START ${name}`);
  let log = '';
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, windowsHide: true,
      env: { ...process.env, PROFILE_NO_OUTBOX: '', PROFILE_LOOKUP_CONVERSATION: '',
        PROFILE_POOL_SIZE: '', BENCH_DIAGNOSTIC_PRELOAD: '', LOAD_PROFILE: '', PRIME_MESSAGES: '',
        TS_NODE_PROJECT: path.join(root, 'server/tsconfig.json'), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log += data; process.stdout.write(data); });
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve(signal ? 1 : status ?? 1));
  });
  await writeFile(path.join(output, `${name}.log`), log);
  steps.push({ name, code, seconds: (Date.now() - start) / 1000,
    reports: [...log.matchAll(/(?:Report: |"output":")(.*?)(?:"|\r?\n|$)/g)].map(m => m[1]) });
  await save();
  console.log(`END ${name}: ${code}`);
  return log;
}
if (!process.argv.includes('--supplement')) await run('comprehensive', 'qa/benchmarks/comprehensive-load.mjs');
await run('burst-16000', 'qa/benchmarks/comprehensive-load.mjs', [], {
  LOAD_PROFILE: 'followup', PRIME_MESSAGES: '16000', SOAK_SECONDS: '60'
});
for (const size of [10, 20, 40]) {
  const profileFile = path.join(output, `pool-${size}-profile.json`);
  await run(`pool-${size}`, 'qa/benchmarks/profile-message.mjs', [], {
    API_RATE_LIMIT_MAX: '1000000', PROFILE_POOL_SIZE: String(size),
    PROFILE_LABEL: `${id}/pool-${size}`, PROFILE_OUTPUT: profileFile,
    BENCH_DIAGNOSTIC_PRELOAD: path.join(root, 'qa/benchmarks/probes/message-profile.cjs')
  });
  // Keep the load summary beside its profiling evidence, without overwriting earlier runs.
  const source = path.join(root, 'test-results/bottleneck-2026-10-18', id, `pool-${size}/report.json`);
  await writeFile(path.join(output, `pool-${size}-load.json`), await readFile(source));
}
let backend;
try {
  process.env.API_RATE_LIMIT_MAX = '1000000';
  backend = await startChatBackend(root);
  const probes = await backend.probeDatabase();
  await writeFile(path.join(output, 'database-probe.json'), JSON.stringify(probes, null, 2));
  steps.push({ name: 'database-probe', code: probes.every(p => p.errors === 0) ? 0 : 1 });
  const loginRows = [];
  for (const concurrency of [1, 8, 32]) {
    const latencies = [], errors = {};
    let attempts = 0;
    const began = performance.now(), until = began + 5000;
    await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
      while (performance.now() < until) {
        attempts++;
        const start = performance.now();
        try {
          const response = await fetch(`${backend.base}/api/chat/v1/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: `bench_user_${1 + worker % 10}`, password: 'BenchmarkOnly123!' }),
            signal: AbortSignal.timeout(15000)
          });
          const body = await response.json();
          if (!response.ok || body.code !== 200 || !body.data?.token)
            throw new Error(`HTTP ${response.status}/code ${body.code}`);
          latencies.push(performance.now() - start);
        } catch (error) { errors[error.message] = (errors[error.message] || 0) + 1; }
      }
    }));
    latencies.sort((a, b) => a - b);
    const seconds = (performance.now() - began) / 1000;
    const pct = p => latencies.length ? latencies[Math.ceil(latencies.length * p) - 1] : null;
    loginRows.push({ concurrency, attempts, success: latencies.length, errors, seconds,
      successPerSecond: latencies.length / seconds, p95Ms: pct(.95), p99Ms: pct(.99) });
    console.log(JSON.stringify({ login: loginRows.at(-1) }));
  }
  await writeFile(path.join(output, 'login-load.json'), JSON.stringify({ rows: loginRows,
    scope: '5 seconds per concurrency; real bcrypt cost 10; repeated fixture accounts; not unique-account capacity or sustained attack resistance.' }, null, 2));
  steps.push({ name: 'login-load', code: loginRows.every(row => row.success === row.attempts) ? 0 : 1 });
  await backend.close(); backend = undefined;
  process.env.API_RATE_LIMIT_MAX = '240';
  backend = await startChatBackend(root);
  // Default limiter, measured independently from throughput tests and fixture requests.
  const statuses = {}, codes = {};
  let retryAfter = 0, next = 0;
  await Promise.all(Array.from({ length: 20 }, async () => {
    while (next < 300) {
      next++;
      const response = await fetch(`${backend.base}/api/chat/v1/message/chat_list`, {
        headers: { Authorization: `Bearer ${backend.auth.token}` }, signal: AbortSignal.timeout(15000)
      });
      const body = await response.json();
      statuses[response.status] = (statuses[response.status] || 0) + 1;
      codes[body.code] = (codes[body.code] || 0) + 1;
      if (Number(response.headers.get('Retry-After')) > 0) retryAfter++;
    }
  }));
  const passed = statuses[200] > 0 && statuses[429] > 0 && retryAfter === statuses[429]
    && Object.keys(statuses).every(s => s === '200' || s === '429');
  await writeFile(path.join(output, 'rate-limit.json'), JSON.stringify({ statuses, codes, retryAfter, passed }, null, 2));
  steps.push({ name: 'default-rate-limit', code: passed ? 0 : 1 });
} finally { if (backend) await backend.close(); }
await save();
for (const mode of ['migrations', 'backend', 'system'])
  await run(`regression-${mode}`, 'server/scripts/run-isolated-tests.js', [mode]);
const testFiles = [];
for (const dir of ['tests/unit', 'tests/database'])
  for (const name of await readdir(path.join(root, dir)))
    if (name.endsWith('.test.js')) testFiles.push(path.join(dir, name));
await run('unit-and-database-guards', '--test', testFiles);
for (const file of ['test-agent-actions.js', 'test-agent-routing.js', 'test-agent-stream.js', 'test-security-regressions.js'])
  await run(file.replace('.js', ''), `server/scripts/${file}`);
await save();
console.log(`Evaluation artifacts: ${output}`);
if (steps.some(s => s.code !== 0)) process.exitCode = 1;
