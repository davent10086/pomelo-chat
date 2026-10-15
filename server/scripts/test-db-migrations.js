const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const serverRoot = path.resolve(__dirname, '..');
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

console.log('[db-migrations] concurrent initialization is serialized and repeated migration is idempotent');
