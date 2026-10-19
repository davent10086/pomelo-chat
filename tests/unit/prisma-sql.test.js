const path = require('node:path');
process.env.TS_NODE_PROJECT = path.resolve(__dirname, '../../server/tsconfig.json');
require('../../server/node_modules/ts-node/register/transpile-only');
const test = require('node:test'), assert = require('node:assert/strict');
const { bindSql } = require('../../server/src/infrastructure/prisma-sql');
const { normalizeDatabaseValue, encodeDatabaseValues, databaseError } = require('../../server/src/infrastructure/prisma');
const { Prisma } = require('../../server/src/generated/prisma/client');

test('raw SQL keeps hostile values bound, including lists, bulk rows and SET objects', () => {
  const hostile = "x' OR 1=1; DROP TABLE user; --";
  const simple = bindSql('SELECT * FROM user WHERE username=? AND id IN (?)', [hostile, [1, 2]]);
  assert.equal(simple.sql, 'SELECT * FROM user WHERE username=? AND id IN (?,?)');
  assert.deepEqual(simple.values, [hostile, 1, 2]);
  const bulk = bindSql('INSERT INTO sample (id,name) VALUES ?', [[[1, hostile], [2, 'safe']]]);
  assert.equal(bulk.sql, 'INSERT INTO sample (id,name) VALUES (?,?),(?,?)');
  assert.deepEqual(bulk.values, [1, hostile, 2, 'safe']);
  const update = bindSql('UPDATE user SET ? WHERE id=?', [{ name: hostile, avatar: undefined }, 1]);
  assert.equal(update.sql, 'UPDATE user SET `name` = ?,`avatar` = ? WHERE id=?');
  assert.deepEqual(update.values, [hostile, null, 1]);
});

test('placeholder scanning respects quoted strings, escaped quotes, identifiers and comments', () => {
  const text = "SELECT '?' AS literal, `?` FROM user /* ? */ WHERE name=? -- ?\n AND id=?";
  const query = bindSql(text, ['name', 3]);
  assert.equal(query.sql, text); assert.deepEqual(query.values, ['name', 3]);
  assert.deepEqual(bindSql("SELECT 'it\\'s ?' WHERE id=?", [1]).values, [1]);
  for (const [sql, values] of [['SELECT ?', []], ['SELECT 1', [1]], ['SELECT ??', ['user']], ['SELECT ?', [[]]], ['UPDATE user SET ?', [{}]], ['UPDATE user SET ?', [{ 'name`=1 --': 2 }]]])
    assert.throws(() => bindSql(sql, values));
});

test('BIGINT normalization preserves API numbers and rejects precision loss', () => {
  const original = new Date(2026, 9, 20, 1, 2, 3, 456), date = encodeDatabaseValues(original), bytes = Buffer.from('data');
  assert.deepEqual(normalizeDatabaseValue([{ id: 1n, count: 2n, date, bytes, optional: null }]), [{ id: 1, count: 2, date: original, bytes, optional: null }]);
  assert.throws(() => normalizeDatabaseValue(9007199254740992n), /safe range/);
});

test('Prisma errors preserve duplicate/deadlock contracts without logging call arguments', () => {
  const failure = (code, meta) => new Prisma.PrismaClientKnownRequestError('password-hash-must-not-be-logged', { code, meta, clientVersion: '7.6.0' });
  const duplicate = databaseError(failure('P2010', { driverAdapterError: { cause: { originalCode: '1062', constraint: { index: 'uniq_message_client' } } } }));
  assert.equal(duplicate.code, 'ER_DUP_ENTRY'); assert.match(duplicate.message, /uniq_message_client/);
  assert.doesNotMatch(duplicate.message, /password/);
  assert.equal(databaseError(failure('P2034', {})).code, 'ER_LOCK_DEADLOCK');
  assert.equal(databaseError(failure('P2028', {})).code, 'P2028');
  assert.equal('cause' in databaseError(failure('P2028', {})), false);
  assert.doesNotMatch(databaseError(failure('P2028', {})).message, /password/);
  const validation = databaseError(new Prisma.PrismaClientValidationError('password-hash-must-not-be-logged', { clientVersion: '7.10.1' }));
  assert.equal(validation.code, 'PRISMA_VALIDATION'); assert.doesNotMatch(validation.message, /password/);
});
