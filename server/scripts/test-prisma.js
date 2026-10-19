const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
if (!process.env.DATABASE_URL_TEST) throw Error('DATABASE_URL_TEST required');
process.env.NODE_ENV = 'test';
require('ts-node/register/transpile-only');
const { initDatabase, closeDatabase, default: migrationPool } = require('../src/infrastructure/database');
const { prisma, ormQuery } = require('../src/infrastructure/prisma');
const { Query, withTransaction } = require('../src/infrastructure/database-query');
const identity = require('../src/modules/identity/repository');
const social = require('../src/modules/social/repository');
const prefix = 'prisma_' + randomUUID().slice(0, 16);
const userData = name => ({ username: name, password: 'test-only-hash', phone: name, name });
(async () => {
  await initDatabase();
  const legacyClock = await new Promise((resolve, reject) => migrationPool.query('SELECT CURRENT_TIMESTAMP(0) AS instant', (error, rows) => error ? reject(error) : resolve(rows[0].instant)));
  const prismaClock = (await Query('SELECT CURRENT_TIMESTAMP(0) AS instant'))[0].instant;
  assert.ok(Math.abs(legacyClock.getTime() - prismaClock.getTime()) < 2000, 'Prisma must preserve existing timestamp interpretation');
  let rolledBackId;
  await assert.rejects(withTransaction(async query => {
    const result = await identity.insertUser(userData(prefix + '_rollback'), query);
    rolledBackId = result.insertId;
    await social.insertDefaultFriendGroup({ user_id: rolledBackId, username: prefix, name: 'rollback' }, query);
    const raw = await query('SELECT CONNECTION_ID() AS id');
    const model = await ormQuery(query, db => db.$queryRaw`SELECT CONNECTION_ID() AS id`, () => { throw Error('Expected ORM transaction'); });
    assert.equal(raw[0].id, model[0].id, 'model and raw SQL share one connection');
    assert.equal((await query('SELECT id FROM user WHERE id=?', [rolledBackId])).length, 1);
    throw Error('rollback model and raw together');
  }), /rollback model and raw together/);
  assert.equal(await prisma.user.count({ where: { id: rolledBackId } }), 0);
  assert.equal(await prisma.friend_group.count({ where: { user_id: rolledBackId } }), 0);
  const committed = await withTransaction(async query => {
    const result = await identity.insertUser(userData(prefix + '_committed'), query);
    await query('INSERT INTO friend_group SET ?', { user_id: result.insertId, username: prefix, name: 'committed' });
    return result.insertId;
  });
  assert.equal((await identity.findPublicProfile([committed]))[0].id, committed);
  const storedDate = (await Query('SELECT created_at FROM user WHERE id=?', [committed]))[0].created_at;
  const modelDate = (await identity.findUserById([committed]))[0].created_at;
  assert.equal(storedDate.getTime(), modelDate.getTime(), 'model and raw reads interpret stored dates identically');
  assert.ok(Math.abs(storedDate.getTime() - legacyClock.getTime()) < 10000, 'model default timestamps retain the database wall clock');
  const instant = new Date(2026, 9, 20, 1, 2, 3);
  await Query('UPDATE user SET created_at=? WHERE id=?', [instant, committed]);
  const nativeDate = await new Promise((resolve, reject) => migrationPool.query('SELECT created_at FROM user WHERE id=?', [committed], (error, rows) => error ? reject(error) : resolve(rows[0].created_at)));
  assert.equal(nativeDate.getTime(), instant.getTime(), 'Date parameters retain mysql2 local wall-clock encoding');
  assert.equal((await identity.findUserById([committed]))[0].created_at.getTime(), instant.getTime());
  const modelInstant = new Date(2026, 9, 20, 4, 5, 6);
  await ormQuery(Query, db => db.user.updateMany({ where: { id: committed }, data: { created_at: modelInstant } }), () => { throw Error('Expected ORM executor'); });
  const nativeModelDate = await new Promise((resolve, reject) => migrationPool.query('SELECT created_at FROM user WHERE id=?', [committed], (error, rows) => error ? reject(error) : resolve(rows[0].created_at)));
  assert.equal(nativeModelDate.getTime(), modelInstant.getTime(), 'model Date parameters retain mysql2 local wall-clock encoding');
  const hostile = "not-a-user' OR 1=1 --";
  assert.deepEqual(await identity.findUserByUsername([hostile]), []);
  assert.deepEqual(await Query('SELECT id FROM user WHERE username=?', [hostile]), []);
  // Concurrent inserts must not read a different pooled connection's LAST_INSERT_ID.
  const ids = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const username = prefix + '_' + i;
    const result = await Query('INSERT INTO user (username,password,phone) VALUES (?,?,?)', [username, 'test-only', username]);
    assert.equal((await Query('SELECT username FROM user WHERE id=?', [result.insertId]))[0].username, username);
    return result.insertId;
  }));
  assert.equal(new Set(ids).size, 20);
  const rows = await Query('SELECT COUNT(*) AS total FROM user WHERE username LIKE ?', [prefix + '%']);
  assert.equal(typeof rows[0].total, 'number');
  assert.equal(rows[0].total, 21);
  console.log('[prisma] model/raw transaction commit, rollback, connection affinity, hostile values, concurrent insert IDs and numeric results passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { await Query('DELETE FROM user WHERE username LIKE ?', [prefix + '%']); }
  finally { await closeDatabase(); }
});
