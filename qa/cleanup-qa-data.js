#!/usr/bin/env node
/* eslint-disable no-console */
const mysql = require('../server/node_modules/mysql');

const runId = process.env.QA_RUN_ID;
const databaseUrl = process.env.DATABASE_URL_TEST || process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL_TEST;
const redisKeyPrefix = process.env.REDIS_KEY_PREFIX;
if (!runId || !databaseUrl) throw new Error('QA_RUN_ID and DATABASE_URL_TEST are required for QA cleanup');

const parsed = new URL(databaseUrl);
const database = decodeURIComponent(parsed.pathname.slice(1));
if (!/(^|[_-])test([_-]|$)|[_-]test$/i.test(database)) {
  throw new Error(`Refusing to clean non-test database: ${database}`);
}

const connection = mysql.createConnection({
  host: parsed.hostname,
  port: Number(parsed.port || 3306),
  user: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password),
  database,
  multipleStatements: false
});
const query = (sql, params = []) => new Promise((resolve, reject) => connection.query(sql, params, (error, result) => error ? reject(error) : resolve(result)));

const cleanupRedis = async () => {
  if (!redisUrl || !redisKeyPrefix) return;
  const Redis = require('../server/node_modules/ioredis');
  const redis = new Redis(redisUrl);
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${redisKeyPrefix}*`, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length) await redis.unlink(...keys);
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
};

(async () => {
  const users = await query('SELECT id FROM user WHERE username LIKE ?', [`qa_${runId}_%`]);
  const userIds = users.map(row => row.id);
  if (!userIds.length) return;
  const groups = await query(`SELECT id, room FROM group_chat WHERE creator_id IN (?)`, [userIds]);
  const groupIds = groups.map(row => row.id);
  const rooms = groups.map(row => row.room);
  const friends = await query(`SELECT f.room FROM friend f JOIN friend_group fg ON fg.id = f.group_id WHERE fg.user_id IN (?)`, [userIds]);
  rooms.push(...friends.map(row => row.room));
  const uniqueRooms = [...new Set(rooms.filter(Boolean))];

  await query('DELETE FROM mcp_audit_log WHERE user_id IN (?)', [userIds]);
  await query('DELETE FROM assistant_memory WHERE user_id IN (?)', [userIds]);
  await query('DELETE FROM assistant_task WHERE user_id IN (?)', [userIds]);
  if (uniqueRooms.length) {
    await query('DELETE FROM message WHERE room IN (?)', [uniqueRooms]);
    await query('DELETE FROM message_statistics WHERE room IN (?)', [uniqueRooms]);
    await query('DELETE FROM conversation WHERE room IN (?)', [uniqueRooms]);
  }
  if (groupIds.length) await query('DELETE FROM group_chat WHERE id IN (?)', [groupIds]);
  await query('DELETE f FROM friend f JOIN friend_group fg ON fg.id = f.group_id WHERE fg.user_id IN (?)', [userIds]);
  await query('DELETE FROM friend_group WHERE user_id IN (?)', [userIds]);
  await query('DELETE FROM user WHERE id IN (?)', [userIds]);
  console.log(`[qa-cleanup] removed data for ${runId}`);
})().then(cleanupRedis).finally(() => connection.end());
