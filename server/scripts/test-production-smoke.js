const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
if (!process.env.DATABASE_URL_TEST || !process.env.TEST_REDIS_KEY_PREFIX) throw Error('Use isolated test runner');
const cwd = path.resolve(__dirname, '..');
const env = { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'production-smoke-test-secret', PORT: '0', REQUEST_LOGS: 'false' };
for (const invalid of [{ JWT_SECRET: '' }, { PORT: 'abc' }, { MAX_UPLOAD_CHUNKS: 'abc' }]) {
  const result = spawnSync(process.execPath, ['dist/index.js'], { cwd, env: { ...env, ...invalid }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 1, 'invalid configuration must fail before serving');
  assert.match(result.stderr, /JWT_SECRET|PORT|MAX_UPLOAD_CHUNKS/);
}
const child = spawn(process.execPath, ['-e', `
const {server,stopServer}=require('./dist/index.js');
server.once('listening',()=>process.send({port:server.address().port}));
process.on('message',async()=>{await stopServer();process.disconnect();});
`], { cwd, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
let errors = '';
child.stderr.on('data', data => { errors += data.toString(); });
const timeout = setTimeout(() => child.kill(), 20000);
(async () => {
  const ready = await new Promise((resolve, reject) => {
    child.once('message', resolve); child.once('error', reject);
    child.once('exit', code => reject(new Error(`compiled server exited ${code}: ${errors}`)));
  });
  const base = `http://127.0.0.1:${ready.port}/api/chat/v1`;
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/ready')).status, 200);
  assert.equal((await fetch(base + '/message/chat_list')).status, 401);
  const exit = new Promise(resolve => child.once('exit', resolve)); child.send('stop');
  assert.equal(await exit, 0); console.log('[production-smoke] compiled server startup, assets, fail-fast config, readiness, authentication and graceful shutdown passed');
})().catch(error => { console.error(error); child.kill(); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
