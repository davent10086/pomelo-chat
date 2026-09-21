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

const first = runMigration();
const second = runMigration();
for (const output of [first, second]) {
  assert.match(output, /\[db:migrate\] completed/);
  assert.doesNotMatch(output, /MySQL 数据表初始化\/迁移失败/);
  assert.doesNotMatch(output, /ER_CANT_DROP_FIELD_OR_KEY/);
}

console.log('[db-migrations] repeated migration is idempotent');
