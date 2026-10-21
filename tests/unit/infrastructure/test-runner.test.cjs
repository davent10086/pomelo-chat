const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { discover } = require('../../helpers/discovery.cjs');
const { tapCounts, summarize, writeReport } = require('../../helpers/report.cjs');
const { runId, assertOwnedPath, assertTestTarget, assertNotProduction } = require('../../helpers/environment.cjs');
const { runProcess } = require('../../helpers/process.cjs');
const { parse } = require('../../run.cjs');

test('discovery automatically includes nested new tests and excludes helpers and symlinks', async t => {
  const root = path.join(process.env.TEST_TMPDIR, 'discovery');
  await fs.mkdir(path.join(root, 'tests/unit/nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/unit/nested/new.test.cjs'), '');
  await fs.writeFile(path.join(root, 'tests/unit/nested/helper.cjs'), '');
  await fs.mkdir(path.join(root, 'external'), { recursive: true });
  await fs.writeFile(path.join(root, 'external/not-owned.test.cjs'), '');
  await fs.symlink(path.join(root, 'external'), path.join(root, 'tests/unit/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(discover('unit', root), ['tests/unit/nested/new.test.cjs']);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
});

test('resource names are unique, production targets and computed cleanup escapes are refused', () => {
  assert.notEqual(runId(), runId());
  assert.throws(() => assertOwnedPath('F:/'), /Temporary cleanup/);
  assert.throws(() => assertOwnedPath(path.resolve('tmp/tests/../uploads')), /Temporary cleanup/);
  assert.throws(() => assertNotProduction({ NODE_ENV: 'production' }), /production/);
  assert.throws(() => assertNotProduction({ APP_ENV: 'production' }), /production/);
  assert.throws(() => assertTestTarget('mysql://invalid:invalid@127.0.0.1/production'), /explicit test database/);
  assert.throws(() => assertTestTarget('postgres://invalid:invalid@127.0.0.1/pomelo_test'), /MySQL/);
  assert.equal(assertTestTarget('mysql://invalid:invalid@127.0.0.1/pomelo_test').pathname, '/pomelo_test');
});

test('summary preserves failed, timed out, skipped and cancelled cases instead of claiming success', async t => {
  assert.deepEqual(tapCounts('# tests 4\n# pass 2\n# fail 1\n# skipped 1\n# cancelled 0\n'), { total: 4, passed: 2, failed: 1, skipped: 1, cancelled: 0 });
  assert.equal(summarize([{ status: 'timedOut' }, { status: 'passed' }]).failed, 1);
  const directory = path.join(process.env.TEST_TMPDIR, 'reports');
  const report = { artifacts: directory, startedAt: new Date().toISOString(), suites: [{ status: 'passed', counts: { total: 1, passed: 0, skipped: 1 } }] };
  const output = await writeReport(report);
  assert.equal(JSON.parse(await fs.readFile(output)).status, 'partial');
  report.suites = [{ status: 'passed', counts: { total: 1, failed: 1 } }];
  await writeReport(report);
  assert.equal(JSON.parse(await fs.readFile(output)).status, 'failed', 'A zero exit code must not hide failing case counts');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
});

test('child failure, timeout and cancellation produce non-success statuses and retained logs', async () => {
  const options = { cwd: process.cwd(), env: process.env, quiet: true, logPath: path.join(process.env.TEST_TMPDIR, 'child.log') };
  const failed = await runProcess(process.execPath, ['-e', 'console.log("retained failure");process.exitCode=7'], options);
  assert.equal(failed.exitCode, 7); assert.equal(failed.status, 'failed');
  assert.match(await fs.readFile(options.logPath, 'utf8'), /retained failure/);
  const timed = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, timeoutMs: 150 });
  assert.equal(timed.status, 'timedOut');
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  assert.equal((await pending).status, 'interrupted');
});

test('unit preload rejects accidental service connections and filters retain their exact meaning', () => {
  const preload = path.resolve(__dirname, '../../helpers/bootstrap.cjs');
  const result = spawnSync(process.execPath, ['--require', preload, '-e', 'require("node:net").connect(6379,"127.0.0.1")'], {
    env: { ...process.env, TEST_LAYER: 'unit' }, encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Unit tests must not open network/);
  assert.deepEqual(parse(['integration', '--filter', 'assistant/', '--tag', 'security']).extra, []);
  assert.throws(() => parse(['unit', '--timeout', 'NaN']), /positive milliseconds/);
  assert.throws(() => parse(['unit', '--typo']), /Unsupported arguments/);
  assert.throws(() => parse(['unit', '--filter']), /requires a value/);
});
