/** Unified local/production launcher. No secrets are written to disk. */
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const serverRoot = path.join(root, 'server');
const requireServer = createRequire(path.join(serverRoot, 'package.json'));
const fileEnv = fs.existsSync(path.join(serverRoot, '.env')) ? requireServer('dotenv').parse(fs.readFileSync(path.join(serverRoot, '.env'))) : {};
const env = { ...fileEnv, ...process.env };
// Resolve Node's legacy fallback once, so both runtimes receive the same database target.
if (!env.DATABASE_URL_TEST && !env.TEST_DATABASE_URL) {
  const configuration = [path.join(serverRoot, 'config.json'), path.join(serverRoot, 'src/model/config.json')].find(file => fs.existsSync(file));
  if (configuration) {
    let database;
    try { database = JSON.parse(fs.readFileSync(configuration, 'utf8')); } catch { throw new Error('Invalid legacy database configuration'); }
    for (const [key, field] of Object.entries({ DB_HOST: 'host', DB_PORT: 'port', DB_USER: 'user', DB_PASSWORD: 'password', DB_NAME: 'database' }))
      if (!env[key] && database[field]) env[key] = String(database[field]);
  }
}
const dev = process.argv.includes('--dev');
env.REALTIME_DRIVER ||= 'go'; env.OUTBOX_DRIVER ||= 'go';
for (const key of ['REALTIME_DRIVER', 'OUTBOX_DRIVER']) if (!['node', 'go'].includes(env[key])) throw new Error(`Invalid ${key}`);
const usesGo = env.REALTIME_DRIVER === 'go' || env.OUTBOX_DRIVER === 'go';
if (usesGo && dev && !env.REALTIME_INTERNAL_TOKEN) env.REALTIME_INTERNAL_TOKEN = randomBytes(32).toString('hex');
if (usesGo && (env.REALTIME_INTERNAL_TOKEN?.length || 0) < 32) throw new Error('Set REALTIME_INTERNAL_TOKEN to at least 32 characters');
if (usesGo && !env.JWT_SECRET) throw new Error('Set JWT_SECRET before starting');
const publicPort = Number(env.PORT || 3000);
const nodePort = env.REALTIME_DRIVER === 'go' ? Number(env.NODE_PORT || 3001) : publicPort;
if (![publicPort, nodePort].every(p => Number.isInteger(p) && p > 0 && p < 65536)) throw new Error('Invalid service port');
if (env.REALTIME_DRIVER === 'go' && nodePort === publicPort) throw new Error('Node and Go ports must differ');
env.NODE_INTERNAL_URL ||= `http://127.0.0.1:${nodePort}`;
env.GO_REALTIME_ADDR ||= env.REALTIME_DRIVER === 'go' ? `:${publicPort}` : '127.0.0.1:3101';
const children = new Set(); let stopping = false;
function launch(file, args, cwd, childEnv = env) {
  const child = spawn(file, args, { cwd, env: childEnv, stdio: 'inherit' }); children.add(child);
  child.on('error', e => { console.error('[stack]', e.message); void stop(1); });
  child.on('exit', code => { children.delete(child); if (!stopping) void stop(code || 1); }); return child;
}
async function stop(code = 0) {
  if (stopping) return; stopping = true; process.exitCode = code;
  await Promise.all([...children].map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000); timer.unref();
  })));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); });
(async () => {
  let binary;
  if (usesGo) {
    binary = env.REALTIME_BINARY || path.join(root, 'services/realtime/bin', process.platform === 'win32' ? 'pomelo-realtime.exe' : 'pomelo-realtime');
    if (!env.REALTIME_BINARY) {
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      const build = spawn('go', ['build', '-o', binary, '.'], { cwd: path.join(root, 'services/realtime'), env, stdio: 'inherit' });
      const code = await new Promise((resolve, reject) => { build.once('exit', resolve); build.once('error', reject); });
      if (code !== 0) throw new Error('Go build failed');
    }
  }
  if (stopping) return;
  const nodeEnv = { ...env, PORT: String(nodePort), BIND_HOST: env.BIND_HOST || (env.REALTIME_DRIVER === 'go' ? '127.0.0.1' : '0.0.0.0') };
  // A single owned child avoids orphaned nodemon grandchildren on Windows.
  launch(process.execPath, dev ? ['-r', requireServer.resolve('ts-node/register/transpile-only'), path.join(serverRoot, 'src/index.ts')] : [path.join(serverRoot, 'dist/index.js')], serverRoot, nodeEnv);
  if (!usesGo) return;
  const deadline = Date.now() + 60000;
  while (!stopping) {
    try { if ((await fetch(env.NODE_INTERNAL_URL + '/api/chat/v1/health', { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Node service startup timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (stopping) return;
  launch(binary, ['-role', env.REALTIME_DRIVER === 'go' ? env.OUTBOX_DRIVER === 'go' ? 'all' : 'gateway' : 'worker'], root);
})().catch(e => { console.error('[stack]', e.message); void stop(1); });
