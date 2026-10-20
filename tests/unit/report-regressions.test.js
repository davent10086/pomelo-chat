const path = require('node:path');
process.env.TS_NODE_PROJECT = path.resolve(__dirname, '../../server/tsconfig.json');
require('../../server/node_modules/ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { positiveId, boundedInteger } = require('../../server/src/shared/validation');
const social = require('../../server/src/modules/social/repository');
const read = require('../../server/src/read-models/messaging');
const { fetchHistoryMessages } = require('../../server/src/modules/messaging/queries');
const application = require('../../server/src/modules/messaging/application');
const { createFriendApplication } = require('../../server/src/modules/social/friends');
const { createGroupApplication } = require('../../server/src/modules/social/groups');
const { RespData, RespError } = require('../../server/src/infrastructure/http-response');
const actor = { id: 1, username: 'alice' };
const effects = { notifyUser: async () => {}, isOnline: () => false, initializeGroupMessage: async () => {} };

test('scalar IDs reject parser arrays, objects, booleans and unsafe numbers', () => {
  for (const value of [[1], [1, 2], { a: 1 }, true, null, '', '1e3', '1.2', '-1', '0', '9007199254740992']) assert.equal(positiveId(value), null);
  assert.equal(positiveId('42'), 42); assert.equal(positiveId(42), 42);
});

test('invalid numeric environment cannot silently disable a guard', t => {
  const previous = process.env.TEST_LIMIT;
  t.after(() => previous === undefined ? delete process.env.TEST_LIMIT : process.env.TEST_LIMIT = previous);
  for (const value of ['abc', 'NaN', '-1', '0', '1.5', '10oops', '9007199254740992']) {
    process.env.TEST_LIMIT = value;
    assert.throws(() => boundedInteger('TEST_LIMIT', 100), /TEST_LIMIT/);
  }
  delete process.env.TEST_LIMIT; assert.equal(boundedInteger('TEST_LIMIT', 100), 100);
});

test('room authorization failures use 403 business code; valid session is not revoked', async t => {
  t.mock.method(social, 'findAccessibleGroupRoom', async () => []);
  t.mock.method(social, 'findGroupMembership', async () => []);
  assert.equal((await application.getHistory(actor, { room: 'group', type: 'group' })).code, 1006);
  assert.equal((await application.markRead(actor, { room: 'group', type: 'group', roomSeq: 1 })).code, 1006);
  const groups = createGroupApplication(effects);
  assert.equal((await groups.getGroupChatInfo(actor, { group_id: '2' })).code, 1006);
  assert.equal((await groups.getGroupMemberList(actor, { group_id: '2', room: 'group' })).code, 1006);
});

test('history uses n+1 in both directions and exposes a forward sequence cursor', async t => {
  t.mock.method(social, 'findAccessibleGroupRoom', async () => [{ id: 2 }]);
  const row = id => ({ id, room_seq: id, created_at: new Date(), file_size: 0 });
  let data = [row(1), row(2), row(3)];
  t.mock.method(read, 'listHistoryAfterSequence', async args => { assert.equal(args[3], 3); return data; });
  const forward = await fetchHistoryMessages(1, 'group', 'group', undefined, 2, 0);
  assert.equal(forward.hasMore, true); assert.equal(forward.nextAfterSeq, 2);
  assert.deepEqual(forward.messages.map(item => item.id), [1, 2]);
  data = [row(1), row(2)];
  assert.equal((await fetchHistoryMessages(1, 'group', 'group', undefined, 2, 0)).hasMore, false);
  t.mock.method(read, 'listHistoryBeforeId', async args => { assert.equal(args.at(-1), 3); return [row(1), row(2), row(3)]; });
  const backward = await fetchHistoryMessages(1, 'group', 'group', undefined, 2);
  assert.deepEqual(backward.messages.map(item => item.id), [2, 3]); assert.equal(backward.nextBeforeId, 2);
});

test('invalid profile query/group name is rejected before SQL', async () => {
  const friends = createFriendApplication(effects);
  for (const id of [[1, 2], { a: 1 }, 'abc']) assert.equal((await friends.getFriendById(actor, { id })).code, 1003);
  assert.equal((await friends.createFriendGroup(actor, { name: 'a'.repeat(51) })).code, 1003);
});

test('HTTP mapping preserves false and zero and distinguishes upstream failures', () => {
  const response = { status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
  RespData(response, false); assert.equal(response.body.data, false);
  RespData(response, 0); assert.equal(response.body.data, 0);
  for (const [code, status] of [[1002, 401], [1006, 403], [6003, 413], [8004, 504], [1008, 503]]) {
    RespError(response, code); assert.equal(response.statusCode, status);
  }
});

test('migration test refuses non-test database before any child can mutate it', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../server/scripts/test-db-migrations.js')], {
    encoding: 'utf8', env: { ...process.env, NODE_ENV: 'development', DATABASE_URL_TEST: 'mysql://invalid:invalid@127.0.0.1:1/production', TEST_DATABASE_URL: '' }, timeout: 5000
  });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /explicit test database/);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|Access denied/);
});
