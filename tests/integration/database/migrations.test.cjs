const { serverRequire, serverRoot: testServerRoot, repoRoot: testRepoRoot } = require("../../helpers/paths.cjs");
process.env.NODE_ENV = 'test';
// Validate before spawning ANY child that can initialize or mutate the database.
serverRequire('dotenv').config({ path: require('node:path').join(testServerRoot, '.env'), quiet: true });
const testUrl = process.env.DATABASE_URL_TEST || process.env.TEST_DATABASE_URL;
if (!testUrl || !/(^|[_-])test([_-]|$)|[_-]test$/i.test(decodeURIComponent(new URL(testUrl).pathname.slice(1))))
  throw new Error('DATABASE_URL_TEST must name an explicit test database');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const serverRoot = testServerRoot;
const runMigration = () => execFileSync(process.execPath, [
  path.join(serverRoot, 'node_modules', 'ts-node', 'dist', 'bin.js'),
  '--files',
  'src/model/migrate.ts'
], {
  cwd: serverRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});

const concurrent = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', `
  const {default: db, initDatabase} = require('./src/infrastructure/database');
  Promise.all([initDatabase(), initDatabase()])
    .then(() => console.log('[db:migrate] concurrent completed'))
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => db.end());
`], { cwd: serverRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
assert.match(concurrent, /\[db:migrate\] concurrent completed/);
assert.equal((concurrent.match(/MySQL 数据表初始化\/迁移完成/g) || []).length, 2);
const first = runMigration();
const second = runMigration();
for (const output of [first, second]) {
  assert.match(output, /\[db:migrate\] completed/);
  assert.doesNotMatch(output, /MySQL 数据表初始化\/迁移失败/);
  assert.doesNotMatch(output, /ER_CANT_DROP_FIELD_OR_KEY/);
}

// Exercise an existing pre-index outbox, including in-flight and delivered records.
const legacy = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', `
  const assert = require('node:assert/strict');
  const {randomUUID} = require('node:crypto');
  const {default: db, initDatabase} = require('./src/infrastructure/database');
  const {Query} = require('./src/infrastructure/database-query');
  const prefix = 'migration_' + randomUUID();
  let userId, conversationId;
  (async () => {
    const user = await Query('INSERT INTO user (username,password,phone) VALUES (?,?,?)', [prefix,'test-only',prefix]); userId=user.insertId;
    const conversation = await Query('INSERT INTO conversation (room,type,target_id,last_seq) VALUES (?,?,?,?)', [prefix,'private',userId,3]); conversationId=conversation.insertId;
    for(let seq=1;seq<=3;seq++) {
      const msg = await Query('INSERT INTO message (conversation_id,sender_id,receiver_id,content,room,type,media_type,room_seq) VALUES (?,?,?,?,?,?,?,?)', [conversationId,userId,userId,'legacy',prefix,'private','text',seq]);
      await Query('INSERT INTO message_outbox (message_id,conversation_id,attempts,claim_token,lease_until,delivered_at) VALUES (?,?,2,?,DATE_ADD(NOW(), INTERVAL 60 SECOND),?)', [msg.insertId,conversationId,seq===1?'legacy-claim':null,seq===3?new Date():null]);
    }
    const before = await Query('SELECT message_id,attempts,claim_token,lease_until,delivered_at FROM message_outbox WHERE conversation_id=? ORDER BY message_id',[conversationId]);
    await Query('DELETE FROM schema_migrations WHERE id=?',['outbox_pending_conversation_v1']);
    await Query('ALTER TABLE message_outbox DROP INDEX idx_outbox_room_pending, DROP COLUMN conversation_id');
    await initDatabase(); await initDatabase();
    const after = await Query('SELECT message_id,attempts,claim_token,lease_until,delivered_at FROM message_outbox WHERE conversation_id=? ORDER BY message_id',[conversationId]);
    assert.deepEqual(after,before,'migration must preserve claims, retry counts and delivery markers');
    const wrong = await Query('SELECT o.message_id FROM message_outbox o JOIN message m ON m.id=o.message_id WHERE o.conversation_id<>m.conversation_id OR o.conversation_id IS NULL');
    assert.equal(wrong.length,0);
    console.log('[db-migrations] legacy outbox backfill preserves pending, leased and delivered records');
  })().finally(async()=>{if(userId) await Query('DELETE FROM user WHERE id=?',[userId]);if(conversationId)await Query('DELETE FROM conversation WHERE id=?',[conversationId]);await require('./src/infrastructure/database').closeDatabase();}).catch(error=>{console.error(error);process.exitCode=1;});
`], { cwd: serverRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
assert.match(legacy,/legacy outbox backfill preserves/);

console.log('[db-migrations] concurrent initialization is serialized and repeated migration is idempotent');
