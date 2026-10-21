#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { repoRoot, serverRoot, serverRequire } = require('./helpers/paths.cjs');
const { createEnvironment, runId, loadConfiguration, assertNotProduction } = require('./helpers/environment.cjs');
const { runProcess } = require('./helpers/process.cjs');
const { discover, inventory, tagsFor } = require('./helpers/discovery.cjs');
const { tapCounts, writeReport } = require('./helpers/report.cjs');
const bootstrap = path.join(__dirname, 'helpers/bootstrap.cjs');

const allocatePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer(); socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(error => error ? reject(error) : resolve(port)); });
});
const parse = input => {
  const args = [...input].filter(value => value !== '--');
  const mode = args.shift() || 'unit';
  const options = { mode, filter: '', extra: [], list: false, timeoutMs: 300000, coverage: mode === 'coverage' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--filter') options.filter = args[++index] || '';
    else if (arg.startsWith('--filter=')) options.filter = arg.slice(9);
    else if (arg === '--list') options.list = true;
    else if (arg === '--tag') options.tag = args[++index];
    else if (arg === '--timeout') options.timeoutMs = Number(args[++index]);
    else options.extra.push(arg);
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('--timeout must be positive milliseconds');
  if (options.extra.length && !['e2e', 'rtc', 'ai-live'].includes(mode)) throw new Error('Unsupported arguments: ' + options.extra.join(' '));
  if (args.includes('--filter') && !options.filter) throw new Error('--filter requires a value');
  if (args.includes('--tag') && !options.tag) throw new Error('--tag requires a value');
  return options;
};
const select = (layer, options) => discover(layer).filter(file => (!options.filter || file.includes(options.filter)) && (!options.tag || tagsFor(file).includes(options.tag)));

const main = async (input = process.argv.slice(2)) => {
  const options = parse(input);
  if (options.mode === 'list') { console.log(JSON.stringify(inventory(), null, 2)); return 0; }
  if (options.mode === 'security') options.tag = 'security';
  const layers = options.mode === 'ci' ? ['checks', 'build', 'unit', 'integration', 'e2e']
    : options.mode === 'security' ? ['unit', 'integration', 'e2e']
    : options.mode === 'server' ? ['checks', 'build', 'unit', 'integration']
    : options.mode === 'coverage' ? ['unit'] : [options.mode];
  if (options.list) {
    console.log(JSON.stringify(layers.flatMap(layer => ['build', 'desktop-smoke', 'desktop-production', 'qa'].includes(layer) ? [{ layer }] : select(layer, options).map(file => ({ layer, file }))), null, 2)); return 0;
  }
  assertNotProduction();
  const configuration = await loadConfiguration();
  const id = runId(), artifacts = path.join(repoRoot, 'test-results', id);
  const report = { schemaVersion: 1, runId: id, mode: options.mode, startedAt: new Date().toISOString(), artifacts, suites: [] };
  report.excluded = ['qa', 'rtc', 'desktop', 'desktop-smoke', 'desktop-production', 'performance', 'ai-live', 'benchmarks'].filter(layer => !layers.includes(layer));
  let builtServer = false;
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  await fs.mkdir(artifacts, { recursive: true });
  const execute = async (name, layer, command, args, environment, cwd = repoRoot) => {
    const logPath = path.join(artifacts, `${report.suites.length + 1}-${name.replace(/[^a-z0-9.-]/gi, '_')}.log`);
    const result = await runProcess(command, args, { cwd, env: environment.env, logPath, timeoutMs: options.timeoutMs, signal: abort.signal });
    const counts = tapCounts(result.output);
    const failedCases = [...result.output.matchAll(/^not ok \d+ - (.*)$/gm)].map(match => match[1]);
    const record = { name, layer, status: result.status, durationMs: result.durationMs, exitCode: result.exitCode, counts, failedCases, logPath, error: result.error,
      resourceRunId: environment.id, artifacts: environment.artifacts,
      resources: { database: environment.database, redisPrefix: environment.prefix, temporary: environment.temporary } };
    report.suites.push(record);
    return record;
  };
  const isolated = async (name, layer, services, work) => {
    let environment;
    try { environment = await createEnvironment(layer, { services, sourceEnv: configuration }); await work(environment); }
    catch (error) { console.error(`[tests] ${name}: ${error.message}`); report.suites.push({ name, layer, status: 'failed', error: error.message, counts: { total: 0, passed: 0, failed: 0, skipped: 0 } }); }
    finally {
      try { await environment?.close(); }
      catch (error) { report.suites.push({ name: `${name}:cleanup`, layer, status: 'failed', error: error.message }); }
      await writeReport(report);
    }
  };
  const pnpm = (args, environment, name) => execute(name, name.includes('build') ? 'build' : 'checks', process.platform === 'win32' ? 'cmd.exe' : 'pnpm', process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm', ...args] : args, environment);
  try {
    for (const layer of layers) {
      if (abort.signal.aborted) break;
      if (['build', 'checks'].includes(layer)) {
        await isolated(layer, layer, false, async environment => {
          if (layer === 'build') { const result = await pnpm(['run', 'build'], environment, 'build'); builtServer = result.status === 'passed'; return; }
          await pnpm(['run', 'lint'], environment, 'lint');
          await pnpm(['--filter', 'pomelo-chat-server', 'exec', 'tsc', '--noEmit'], environment, 'server-types');
          await pnpm(['--filter', 'pomelo-chat-client', 'exec', 'tsc', '--noEmit'], environment, 'client-types');
          await pnpm(['--filter', 'pomelo-chat-server', 'prisma:validate'], environment, 'prisma-schema');
          for (const file of select('checks', options)) await execute(file, layer, process.execPath, [path.join(repoRoot, file)], environment);
        });
      } else if (['e2e', 'rtc', 'ai-live'].includes(layer)) {
        const files = select(layer, options);
        if (!files.length) { if (options.tag) continue; throw new Error('No tests matched ' + layer); }
        await isolated(layer, layer, true, async environment => {
          environment.env.TEST_LAYER = layer;
          environment.env.NODE_OPTIONS = `--require "${bootstrap.replaceAll('\\', '/')}"`;
          environment.env.TEST_API_PORT = String(await allocatePort());
          environment.env.TEST_WEB_PORT = String(await allocatePort());
          while (environment.env.TEST_API_PORT === environment.env.TEST_WEB_PORT) environment.env.TEST_WEB_PORT = String(await allocatePort());
          environment.env.TEST_API_ORIGIN = `http://127.0.0.1:${environment.env.TEST_API_PORT}`;
          environment.env.TEST_WEB_ORIGIN = `http://127.0.0.1:${environment.env.TEST_WEB_PORT}`;
          environment.env.TEST_WS_ORIGIN = `ws://127.0.0.1:${environment.env.TEST_API_PORT}`;
          environment.env.TEST_BROWSER_OUTPUT = path.join(artifacts, layer);
          environment.env.TEST_PLAYWRIGHT_JSON = path.join(artifacts, `${layer}.json`);
          environment.env.TEST_RTC = layer === 'rtc' ? '1' : '0';
          if (layer === 'rtc') {
            environment.env.LIVEKIT_HTTP_URL = configuration.LIVEKIT_HTTP_URL_TEST || 'http://127.0.0.1:7880';
            environment.env.LIVEKIT_URL = configuration.LIVEKIT_URL_TEST || 'ws://127.0.0.1:7880';
            environment.env.LIVEKIT_API_KEY = configuration.LIVEKIT_API_KEY_TEST || 'devkey';
            environment.env.LIVEKIT_API_SECRET = configuration.LIVEKIT_API_SECRET_TEST || 'secret';
            const response = await fetch(environment.env.LIVEKIT_HTTP_URL, { signal: AbortSignal.timeout(5000) }).catch(() => null);
            if (!response) throw new Error('RTC requires a dedicated LiveKit service with room.auto_create=false');
          }
          if (layer === 'ai-live') {
            if (!(configuration.AI_API_KEY || configuration.DASHSCOPE_API_KEY || configuration.DEEPSEEK_API_KEY)) throw new Error('Online model suite requires explicitly configured provider credentials; no live calls were made');
            for (const key of ['AI_API_KEY', 'DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY']) environment.env[key] = configuration[key] || '';
          }
          const record = await execute(layer, layer, process.execPath,
            [path.join(repoRoot, 'node_modules/@playwright/test/cli.js'), 'test', ...(options.filter || options.tag ? files.map(file => file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : []), ...options.extra, `--project=${layer}`], environment);
          try {
            const browser = JSON.parse(await fs.readFile(environment.env.TEST_PLAYWRIGHT_JSON, 'utf8'));
            record.counts = { total: browser.stats.expected + browser.stats.unexpected + browser.stats.skipped + browser.stats.flaky, passed: browser.stats.expected, failed: browser.stats.unexpected + browser.stats.flaky, skipped: browser.stats.skipped };
            const failed = [];
            const visit = suite => { for (const spec of suite.specs || []) if (!spec.ok) failed.push(spec.title); for (const nested of suite.suites || []) visit(nested); };
            for (const suite of browser.suites || []) visit(suite);
            record.failedCases = failed;
          } catch { record.error ||= 'Browser JSON report missing'; record.status = 'failed'; }
        });
      } else if (layer === 'qa') {
        await isolated('qa', layer, true, async environment => {
          environment.env.TEST_LAYER = layer;
          environment.env.NODE_OPTIONS = `--require "${bootstrap.replaceAll('\\', '/')}"`;
          const record = await execute('qa', layer, process.execPath, [path.join(repoRoot, 'qa/run-qa.js')], environment);
          try {
            const results = JSON.parse(await fs.readFile(path.join(environment.artifacts, `qa-results-${environment.id}.json`), 'utf8'));
            record.counts = { total: results.summary.pass + results.summary.fail + results.summary.warn, passed: results.summary.pass, failed: results.summary.fail + results.summary.warn, skipped: 0 };
            record.excludedCases = results.tests.filter(item => item.status === 'skipped');
            record.warnings = results.tests.filter(item => item.status === 'warn');
            record.failedCases = results.tests.filter(item => item.status === 'fail').map(item => item.name);
            if (results.summary.fail || results.summary.warn) record.status = 'failed';
          } catch { record.status = 'failed'; record.error ||= 'QA JSON report missing'; }
        });
      } else if (['desktop-smoke', 'desktop-production'].includes(layer)) {
        await isolated(layer, layer, layer === 'desktop-production', environment => execute(layer, layer, process.execPath,
          [path.join(repoRoot, `desktop/scripts/${layer === 'desktop-smoke' ? 'smoke' : 'production-smoke'}.cjs`)], environment));
      } else {
        const files = select(layer, options);
        if (!files.length) { if (options.tag) continue; throw new Error('No tests matched ' + layer); }
        // A distinct environment per integration file isolates destructive migrations and fault injection.
        const batches = layer === 'unit' ? [files] : files.map(file => [file]);
        for (const batch of batches) {
          if (abort.signal.aborted) break;
          await isolated(batch.join(','), layer, ['integration', 'performance'].includes(layer), async environment => {
            environment.env.TEST_LAYER = layer;
            environment.env.NODE_OPTIONS = `--require "${bootstrap.replaceAll('\\', '/')}"`;
            if (layer === 'integration' && batch.some(file => file.includes('production-smoke')) && !builtServer) {
              const result = await pnpm(['--filter', 'pomelo-chat-server', 'build'], environment, 'server-build');
              builtServer = result.status === 'passed';
              if (!builtServer) throw new Error('Compiled server smoke requires a successful build');
            }
            const args = ['--require', bootstrap, '--test', '--test-concurrency=1', '--test-reporter=tap', ...(options.coverage ? ['--experimental-test-coverage'] : []), ...batch.map(file => path.join(repoRoot, file))];
            await execute(batch.length === 1 ? batch[0] : layer, layer, process.execPath, args, environment, layer === 'integration' ? serverRoot : repoRoot);
          });
        }
      }
    }
  } catch (error) {
    report.suites.push({ name: options.mode, layer: options.mode, status: 'failed', error: error.message }); console.error(error.message);
  } finally {
    if (!report.suites.length) report.suites.push({ name: options.mode, layer: options.mode, status: 'failed', error: 'No suites were selected' });
    if (abort.signal.aborted) report.suites.push({ name: 'interrupted', layer: options.mode, status: 'interrupted' });
    const output = await writeReport(report);
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    console.log(`[tests] ${report.status}: ${report.summary.passed}/${report.summary.suites} suites; report: ${output}`);
  }
  return report.status === 'passed' ? 0 : 1;
};
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, parse, allocatePort };
