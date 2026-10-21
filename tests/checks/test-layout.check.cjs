const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repoRoot } = require('../helpers/paths.cjs');
const { inventory } = require('../helpers/discovery.cjs');
const entries = inventory();
for (const [alias, target] of Object.entries(require('../compatibility.cjs'))) {
  assert.ok(fs.existsSync(path.join(repoRoot, alias)), 'Missing alias: ' + alias);
  assert.ok(fs.existsSync(path.join(repoRoot, target.canonical)), 'Missing canonical test: ' + target.canonical);
  if (/\.test\.|\.check\./.test(target.canonical)) assert.ok(entries.some(item => item.file === target.canonical), 'Undiscovered: ' + target.canonical);
}
for (const layer of ['unit', 'integration', 'e2e', 'rtc', 'performance', 'ai-live']) assert.ok(entries.some(item => item.layer === layer), 'Empty layer: ' + layer);
const scripts = require('../../package.json').scripts;
for (const layer of ['unit', 'integration', 'e2e', 'ci']) assert.equal(scripts['test:' + layer], 'node tests/run.cjs ' + layer);
assert.ok(fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8').includes('run: pnpm test:ci'));
console.log('Test discovery, compatibility targets and canonical CI entrypoint verified');
