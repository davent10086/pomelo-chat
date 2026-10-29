// @tags assistant regression security
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const Module = require('node:module');
const { serverRequire } = require('../../helpers/paths.cjs');
serverRequire('ts-node/register/transpile-only');
process.env.AI_API_KEY = 'deterministic-review-test-key';
process.env.AI_BASE_URL = 'https://model-test.invalid/v1';
let invocations = 0;
let revoke;
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  const actual = originalLoad.call(this, name, parent, isMain);
  if (name !== 'langchain') return actual;
  return { ...actual, createAgent(config) {
    assert.deepEqual(config.tools, [], 'reviews cannot call tools or propose writes');
    return { invoke: async input => {
      invocations++;
      const data = JSON.parse(input.messages[0].content);
      assert.deepEqual(data.range, { since: '2026-10-24', until: '2026-10-24' });
      assert.equal(data.messages.length, 55, 'the real SQL path must paginate beyond 50 messages');
      assert.equal(data.messages[0].text, '原先提议周五上线');
      assert.equal(data.messages.at(-1).text, '最终决定延期，不再周五上线');
      if (revoke) await revoke();
      const last = data.messages.at(-1).id;
      return { structuredResponse: {
        topics: [], decisions: [{ text: '最终决定延期', sourceMessageIds: [last] }],
        questions: [], actions: [], answer: data.question ? [{ text: '因为决定延期', sourceMessageIds: [last] }] : []
      } };
    } };
  } };
};
const { initDatabase, closeDatabase } = require('../../../server/src/infrastructure/database');
const { Query } = require('../../../server/src/infrastructure/database-query');
const { better_chat } = require('../../../server/src/infrastructure/redis');
const { default: app, registerAppRoutes } = require('../../../server/src/controller/app');
Module._load = originalLoad;
const jwt = serverRequire('jsonwebtoken');

test('review HTTP endpoint enforces identity and room scope, reads real paginated history, and stays read-only', async () => {
  const server = http.createServer(app);
  serverRequire('express-ws')(app, server);
  registerAppRoutes();
  try {
    await initDatabase();
    const users = [];
    for (const username of ['review_owner', 'review_peer', 'review_outsider']) {
      const result = await Query('INSERT INTO user SET ?', { username, password: 'test-hash', phone: username });
      const token = jwt.sign({ id: result.insertId, username }, process.env.JWT_SECRET, { expiresIn: '5m' });
      await better_chat.set(`token:${username}`, token, 'EX', 300);
      users.push({ id: result.insertId, username, token });
    }
    const [owner, peer, outsider] = users;
    const group = await Query('INSERT INTO friend_group SET ?', { user_id: owner.id, username: owner.username, name: '好友' });
    await Query('INSERT INTO friend SET ?', { user_id: peer.id, username: peer.username, group_id: group.insertId, room: 'review-room' });
    for (let i = 0; i < 57; i++) await Query('INSERT INTO message SET ?', {
      sender_id: peer.id, receiver_id: owner.id, room: 'review-room', type: 'private', media_type: 'text',
      content: i === 1 ? '原先提议周五上线' : i === 55 ? '最终决定延期，不再周五上线' : `讨论 ${i}`,
      created_at: i === 0 ? '2026-10-23 23:59:59' : i === 56 ? '2026-10-25 00:00:00' : '2026-10-24 10:00:00'
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/chat/v1/assistant/agent/review`;
    const data = { room: 'review-room', range: { preset: 'custom', since: '2026-10-24', until: '2026-10-24' } };
    const call = async (token, body = data) => {
      const response = await fetch(base, { method: 'POST', headers: {
        'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {})
      }, body: JSON.stringify(body) });
      return { status: response.status, ...await response.json() };
    };
    assert.equal((await call()).status, 401);
    assert.equal((await call(outsider.token)).code, 1007);
    assert.equal(invocations, 0);
    assert.equal((await call(owner.token, { ...data, range: { preset: 'custom', since: '2026-02-30', until: '2026-03-01' } })).code, 1003);
    const result = await call(owner.token);
    assert.equal(result.code, 200);
    assert.equal(result.data.coverage.scannedMessages, 55);
    assert.equal(result.data.coverage.hasEarlier, false);
    assert.equal(result.data.decisions[0].sources[0].content, '最终决定延期，不再周五上线');
    const followup = await call(owner.token, { ...data, beforeId: result.data.coverage.newestId + 1, question: '为什么延期？' });
    assert.equal(followup.code, 200);
    assert.equal(followup.data.answer.length, 1);
    for (const table of ['assistant_action', 'assistant_task', 'assistant_memory'])
      assert.equal((await Query(`SELECT COUNT(*) AS total FROM ${table}`))[0].total, 0);
    revoke = () => Query('DELETE FROM friend WHERE group_id = ?', [group.insertId]);
    assert.equal((await call(owner.token)).code, 1007, 'revocation during model generation prevents disclosure');
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await closeDatabase();
    better_chat.disconnect();
  }
});
