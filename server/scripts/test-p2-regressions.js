require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { uploadChunk } = require('../src/service/file');
const { better_chat } = require('../src/utils/authenticate');

const root = path.resolve(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(root, 'src', ...segments), 'utf8');

const response = () => {
  let status;
  let body;
  return {
    res: { status: value => { status = value; return { json: value => { body = value; } }; } },
    value: () => ({ status, body })
  };
};

(async () => {
  const fileResponse = response();
  await uploadChunk({
    user: { id: 1 },
    body: { chunkIndex: '1', fileHash: 'a'.repeat(64), extname: 'png' }
  }, fileResponse.res);
  const missingFile = fileResponse.value();
  assert.equal(missingFile.body.code, 1003);

  const friend = read('service', 'friend', 'index.ts');
  assert.match(friend, /await withTransaction\(async query =>/);
  assert.match(friend, /FOR UPDATE/);
  assert.match(friend, /SELECT id, username, avatar, name FROM user WHERE id = \? AND username = \? FOR UPDATE/);

  const group = read('service', 'group', 'index.ts');
  assert.match(group, /await withTransaction\(async query =>/);
  assert.match(group, /INSERT INTO group_members \(group_id, user_id, nickname\) VALUES \?/);

  console.log('[p2-regressions] transactional writes and missing upload validation passed');
  better_chat.disconnect();
})().catch(error => {
  console.error('[p2-regressions] failed:', error);
  better_chat.disconnect();
  process.exitCode = 1;
});
