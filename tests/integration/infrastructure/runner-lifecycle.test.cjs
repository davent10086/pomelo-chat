// @tags regression infrastructure
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { serverRequire } = require('../../helpers/paths.cjs');
const { createEnvironment } = require('../../helpers/environment.cjs');
const { runProcess } = require('../../helpers/process.cjs');

test('real service cleanup drops only the owned DB/prefix and is idempotent', async () => {
  const mysql = serverRequire('mysql2/promise');
  const Redis = serverRequire('ioredis');
  const parent = await mysql.createConnection(process.env.DATABASE_URL_TEST);
  const redis = new Redis(process.env.REDIS_URL_TEST, { maxRetriesPerRequest: 0 });
  const sentinel = `${process.env.TEST_REDIS_KEY_PREFIX}parent-sentinel`;
  const owned = await createEnvironment('lifecycle', { services: true, sourceEnv: process.env });
  try {
    await redis.set(sentinel, 'keep'); await redis.set(`${owned.prefix}child`, 'remove');
    await fs.writeFile(path.join(owned.temporary, 'temporary'), 'remove');
    await owned.close(); await owned.close();
    assert.equal(await redis.get(sentinel), 'keep'); assert.equal(await redis.get(`${owned.prefix}child`), null);
    assert.equal((await parent.query('SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=?', [owned.database]))[0].length, 0);
    assert.equal(await fs.stat(owned.temporary).then(() => true).catch(() => false), false);
  } finally { await owned.close(); await redis.del(sentinel); redis.disconnect(); await parent.end(); }
});

test('cancelling a process tree closes even a detached descendant listener before resource cleanup', async () => {
  const controller = new AbortController();
  const file = path.join(process.env.TEST_TMPDIR, 'descendant.json');
  const code = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(file)},JSON.stringify({pid:process.pid,port:s.address().port})));`)}],{stdio:'ignore',detached:process.platform!=='win32'});setInterval(()=>{},1000);`;
  const execution = runProcess(process.execPath, ['-e', code], { cwd: process.cwd(), env: process.env, quiet: true, signal: controller.signal, timeoutMs: 10000 });
  let child;
  try {
    for (let index = 0; index < 200; index++) {
      child = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
      if (child) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(child, 'descendant must have opened a listener');
    controller.abort(); assert.equal((await execution).status, 'interrupted');
    const reachable = await new Promise(resolve => {
      const connection = net.connect(child.port, '127.0.0.1');
      connection.once('connect', () => { connection.destroy(); resolve(true); });
      connection.once('error', () => resolve(false));
    });
    assert.equal(reachable, false, 'descendant cannot survive parent cancellation');
  } finally { controller.abort(); await execution; }
});
