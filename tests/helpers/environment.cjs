const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { repoRoot, serverRoot, serverRequire } = require('./paths.cjs');

const runId = () => `test_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const assertNotProduction = (env = process.env) => {
  if (env.NODE_ENV === 'production' || env.APP_ENV === 'production') throw new Error('Test runner refuses production mode');
};
const assertTestTarget = value => {
  const url = new URL(value);
  if (url.protocol !== 'mysql:' || !/(^|[_-])test([_-]|$)|[_-]test$/i.test(decodeURIComponent(url.pathname.slice(1))))
    throw new Error('DATABASE_URL_TEST must name an explicit test database (MySQL)');
  return url;
};
const assertOwnedPath = target => {
  const parent = path.join(repoRoot, 'tmp', 'tests');
  const resolved = path.resolve(target);
  assert.equal(path.dirname(resolved), parent, 'Temporary cleanup must stay directly under tmp/tests');
  assert.match(path.basename(resolved), /^test_\d+_[a-f0-9]{12}$/);
  return resolved;
};
const loadConfiguration = async () => {
  assertNotProduction();
  let file = {};
  try { file = serverRequire('dotenv').parse(await fs.readFile(path.join(serverRoot, '.env'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const env = { ...file, ...process.env };
  assertNotProduction(env);
  return env;
};
const deterministicEnv = env => ({
  ...env, NODE_ENV: 'test', APP_ENV: 'test', TS_NODE_PROJECT: path.join(serverRoot, 'tsconfig.json'), TS_NODE_FILES: 'true',
  JWT_SECRET: 'isolated-test-secret-not-for-production', REQUEST_LOGS: 'false',
  AI_API_KEY: '', DASHSCOPE_API_KEY: '', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', MCP_SERVERS_JSON: '[]',
});

/** Own exactly one database, Redis prefix and temporary directory. Cleanup is idempotent. */
const createEnvironment = async (suite, { services = false, sourceEnv, id = runId() } = {}) => {
  assertNotProduction(sourceEnv || process.env);
  assert.match(id, /^test_\d+_[a-f0-9]{12}$/);
  const configuration = sourceEnv || await loadConfiguration();
  const temporary = assertOwnedPath(path.join(repoRoot, 'tmp', 'tests', id));
  const artifacts = path.join(repoRoot, 'test-results', id);
  await fs.mkdir(temporary, { recursive: true });
  await fs.mkdir(artifacts, { recursive: true });
  const prefix = `test:${id}:`;
  const env = { ...deterministicEnv(configuration), TEST_RUN_ID: id, TEST_TMPDIR: temporary, TEST_ARTIFACT_DIR: artifacts,
    UPLOAD_ROOT: path.join(temporary, 'uploads'), REDIS_KEY_PREFIX: prefix, TEST_REDIS_KEY_PREFIX: prefix };
  await fs.mkdir(env.UPLOAD_ROOT, { recursive: true });
  let admin, redis, database, created = false, closing;
  const close = () => closing ||= (async () => {
    const errors = [];
    if (redis) {
      try {
        if (redis.status === 'ready') {
          let cursor = '0';
          do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
            cursor = next;
            if (keys.length) await redis.del(...keys);
          } while (cursor !== '0');
        }
      } catch (error) { errors.push(new Error(`Redis cleanup failed: ${error.code || error.name}`)); }
      finally { redis.disconnect(); }
    }
    if (admin) {
      try {
        if (created) {
          assert.match(database, /^pomelo_[a-z]+_test_\d+_[a-f0-9]{12}$/);
          await admin.query('DROP DATABASE ??', [database]);
        }
      } catch (error) { errors.push(new Error(`MySQL cleanup failed: ${error.code || error.name}`)); }
      finally { await admin.end().catch(() => undefined); }
    }
    try { await fs.rm(assertOwnedPath(temporary), { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Test resource cleanup failed');
  })();
  try {
    if (services) {
      const configured = configuration.DATABASE_URL_TEST || configuration.TEST_DATABASE_URL;
      const target = configured ? assertTestTarget(configured) : undefined;
      database = `pomelo_${suite.replace(/[^a-z]/g, '')}_test_${id.slice(5)}`;
      const mysql = serverRequire('mysql2/promise');
      admin = await mysql.createConnection({ host: target?.hostname || configuration.DB_HOST || '127.0.0.1',
        port: Number(target?.port || configuration.DB_PORT || 3306),
        user: target ? decodeURIComponent(target.username) : configuration.DB_USER || 'root',
        password: target ? decodeURIComponent(target.password) : configuration.DB_PASSWORD || '', connectTimeout: 5000 });
      await admin.query('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [database]);
      created = true;
      const url = new URL('mysql://localhost');
      url.hostname = target?.hostname || configuration.DB_HOST || '127.0.0.1';
      url.port = target?.port || configuration.DB_PORT || '3306';
      url.username = target ? decodeURIComponent(target.username) : configuration.DB_USER || 'root';
      url.password = target ? decodeURIComponent(target.password) : configuration.DB_PASSWORD || '';
      url.pathname = '/' + database;
      env.DATABASE_URL_TEST = url.toString(); env.TEST_DATABASE_URL = url.toString();
      env.DATABASE_URL = url.toString(); env.DB_NAME = database;
      env.REDIS_URL_TEST = configuration.REDIS_URL_TEST || 'redis://127.0.0.1:6379/15'; env.REDIS_URL = env.REDIS_URL_TEST;
      const Redis = serverRequire('ioredis');
      redis = new Redis(env.REDIS_URL_TEST, { lazyConnect: true, connectTimeout: 5000, commandTimeout: 5000, retryStrategy: () => null, maxRetriesPerRequest: 0 });
      redis.on('error', () => undefined);
      await redis.connect(); await redis.ping();
    } else {
      // Unit tests cannot accidentally connect to the developer's configured services.
      env.DATABASE_URL_TEST = 'mysql://test:test@127.0.0.1:1/pomelo_unit_test';
      env.TEST_DATABASE_URL = env.DATABASE_URL_TEST; env.DATABASE_URL = env.DATABASE_URL_TEST;
      env.DB_NAME = 'pomelo_unit_test'; env.REDIS_URL = 'redis://127.0.0.1:1/15'; env.REDIS_URL_TEST = env.REDIS_URL;
    }
    await fs.writeFile(path.join(temporary, 'ownership.json'), JSON.stringify({ id, database, redisPrefix: prefix, artifacts }));
    return { id, env, temporary, artifacts, database, prefix, close };
  } catch (error) {
    await close().catch(cleanup => console.error(cleanup.message));
    throw new Error(`Test environment unavailable: ${error.code || error.message}`, { cause: error });
  }
};
module.exports = { runId, createEnvironment, assertOwnedPath, assertTestTarget, assertNotProduction, deterministicEnv, loadConfiguration };
