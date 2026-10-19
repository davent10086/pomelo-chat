process.env.TS_NODE_PROJECT = require('node:path').join(process.cwd(), 'server/tsconfig.json');
require('../../server/node_modules/ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFileName } = require('../../server/src/modules/messaging/contracts');

test('attachment display names preserve Unicode without accepting path/control characters', () => {
  assert.equal(normalizeFileName(undefined), null);
  assert.equal(normalizeFileName(null), null);
  assert.equal(normalizeFileName('  会议纪要（草案）2026.txt  '), '会议纪要（草案）2026.txt');
  assert.equal(normalizeFileName('e\u0301.txt'), 'é.txt');
  for (const name of ['', ' ', '.', '..', '../secret.txt', 'C:\\secret.txt', 'line\nname.txt', 'null\0name.txt', '\u202Etxt.exe', 'a'.repeat(256), 42, {}])
    assert.throws(() => normalizeFileName(name), /Invalid attachment name/);
});
