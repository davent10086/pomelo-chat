const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../../server/node_modules/ts-node').register({ transpileOnly: true, project: require('node:path').resolve(__dirname, '../../server/tsconfig.json') });
const { formatHistoryMessages } = require('../../server/src/modules/messaging/queries');
const fixtures = require('../../contracts/realtime-v1.json');
test('Node message projection matches shared Go wire format fixtures', () => {
  for (const row of fixtures.formatCases) {
    const result = formatHistoryMessages([{ ...fixtures.message, media_type: 'text', created_at: new Date(row.timestamp), file_size: row.bytes }])[0];
    assert.equal(result.file_size, row.file_size);
    assert.equal(result.created_at, row.created_at);
  }
  const source = { ...fixtures.message, media_type: 'text', file_size: 0, created_at: new Date(1792368000000) };
  assert.deepEqual(formatHistoryMessages([source])[0], fixtures.message);
});
