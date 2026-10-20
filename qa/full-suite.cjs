/** Run every service-backed server check inside run-isolated-tests.js's disposable database. */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (process.env.NODE_ENV !== 'test' || !process.env.DATABASE_URL_TEST || !process.env.TEST_REDIS_KEY_PREFIX)
  throw new Error('Use pnpm test:full:server to allocate isolated services');
const suites = [
  ['lint'], ['build'],
  ['test:unit'], ['test:database'], ['test:api'], ['test:integration'], ['test:security'],
  ['--filter', 'pomelo-chat-server', 'test:architecture'],
  ['--filter', 'pomelo-chat-server', 'prisma:validate'],
  ['--filter', 'pomelo-chat-server', 'test:db-migrations'],
  ['--filter', 'pomelo-chat-server', 'test:backend'],
  ['--filter', 'pomelo-chat-server', 'test:system'],
  ['--filter', 'pomelo-chat-server', 'test:message-overload'],
  ['--filter', 'pomelo-chat-server', 'test:report-regressions'],
  ['--filter', 'pomelo-chat-server', 'test:production-smoke']
];
let failed = false;
const results = [];
for (const args of suites) {
  console.log(`\n[full-suite] pnpm ${args.join(' ')}`);
  const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: process.env });
  results.push({ command: `pnpm ${args.join(' ')}`, exitCode: result.status, error: result.error?.message });
  if (result.status !== 0) { failed = true; console.error(`[full-suite] FAILED: ${args.join(' ')}`); }
}
const fs = require('node:fs');
fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
fs.writeFileSync(path.join(root, 'test-results/full-server.json'), JSON.stringify({ at: new Date().toISOString(), results, passed: !failed }, null, 2));
process.exitCode = failed ? 1 : 0;
