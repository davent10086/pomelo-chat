const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const result = spawnSync(process.execPath, [require.resolve('../../client/node_modules/vite/bin/vite.js'), 'build', 'client', '--outDir', '../desktop/renderer', '--emptyOutDir'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, POMELO_DESKTOP_BUILD: '1' }
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
if (!fs.existsSync(path.join(root, 'desktop/renderer/index.html'))) throw new Error('Renderer build missing');
