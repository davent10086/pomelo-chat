const fs = require('node:fs');
const path = require('node:path');
const { repoRoot } = require('./paths.cjs');
const roots = { unit: 'tests/unit', integration: 'tests/integration', e2e: 'tests/e2e', checks: 'tests/checks', rtc: 'tests/special/rtc', 'ai-live': 'tests/special/ai-live', performance: 'tests/special/performance', desktop: 'desktop/tests' };
const discover = (layer, root = repoRoot) => {
  if (!roots[layer]) throw new Error('Unknown test layer: ' + layer);
  const suffix = ['e2e', 'rtc', 'ai-live'].includes(layer) ? /\.e2e\.spec\.ts$/ : layer === 'checks' ? /\.check\.cjs$/ : /\.test\.(?:js|cjs|mjs)$/;
  const found = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && suffix.test(entry.name)) found.push(path.relative(root, target).split(path.sep).join('/'));
    }
  };
  visit(path.join(root, roots[layer]));
  return found.sort();
};
const tagsFor = file => (fs.readFileSync(path.join(repoRoot, file), 'utf8').match(/@tags ([^\r\n]+)/)?.[1] || '').split(/[ ,]+/).filter(Boolean);
const inventory = () => Object.keys(roots).flatMap(layer => discover(layer).map(file => ({ layer, file, tags: tagsFor(file) })));
module.exports = { roots, discover, inventory, tagsFor };
