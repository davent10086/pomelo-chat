// @tags regression messaging
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { serverRequire } = require('../../helpers/paths.cjs');
serverRequire('ts-node/register/transpile-only');
const { initDatabase, closeDatabase } = require('../../../server/src/infrastructure/database');
const { Query } = require('../../../server/src/infrastructure/database-query');
const repository = require('../../../server/src/modules/messaging/repository');
const { markRoomRead } = require('../../../server/src/modules/messaging/queries');
const { better_chat } = require('../../../server/src/infrastructure/redis');

test('independent group readers and sends progress while another reader holds its cursor', { timeout: 20000 }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let first, second, writer;
  let timer;
  try {
    await initDatabase();
    const suffix = randomUUID();
    const users = [];
    for (let index = 0; index < 2; index++) {
      const user = await Query('INSERT INTO user (username, password, phone) VALUES (?, ?, ?)', [`read-${suffix}-${index}`, 'unused', `1390000000${index}`]);
      users.push(user.insertId);
    }
    const room = `read-concurrency-${suffix}`;
    const conversation = await Query("INSERT INTO conversation (room, type, last_seq) VALUES (?, 'group', 10)", [room]);
    for (const user of users) await Query('INSERT INTO conversation_read (conversation_id, user_id, last_read_seq) VALUES (?, ?, 0)', [conversation.insertId, user]);
    const advance = repository.advanceReadCursor;
    t.mock.method(repository, 'advanceReadCursor', async (bindings, query) => {
      const result = await advance(bindings, query);
      if (bindings[1] === users[0]) { entered(); await gate; }
      return result;
    });
    assert.equal(await markRoomRead(users[1], room, 'group', 999), 10, 'future sequences are capped');
    first = markRoomRead(users[0], room, 'group', 8);
    await ready;
    second = markRoomRead(users[1], room, 'group', 999);
    writer = Query('UPDATE conversation SET last_seq = 11 WHERE id = ?', [conversation.insertId]);
    const results = await Promise.race([
      Promise.all([second, writer]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('room-wide read lock blocked another reader or sender')), 2000); })
    ]);
    assert.ok([10, 11].includes(results[0]), 'reader may observe the sequence before or after the concurrent send');
    release(); await first;
    assert.equal(await markRoomRead(users[1], room, 'group', 1), results[0], 'stale reads must not regress');
    assert.equal(await markRoomRead(users[1], room, 'group', 999), 11);
    await Query('DELETE FROM conversation_read WHERE conversation_id = ? AND user_id = ?', [conversation.insertId, users[0]]);
    await Promise.all([3, 7, 999].map(sequence => markRoomRead(users[0], room, 'group', sequence)));
    assert.equal(await markRoomRead(users[0], room, 'group', 0), 11, 'concurrent first reads retain the maximum cursor');
  } finally {
    clearTimeout(timer);
    release();
    await Promise.allSettled([first, second, writer]);
    better_chat.disconnect();
    await closeDatabase();
  }
});
