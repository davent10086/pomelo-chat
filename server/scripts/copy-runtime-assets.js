const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'dist/model'), { recursive: true });
fs.copyFileSync(path.join(root, 'src/model/config.json'), path.join(root, 'dist/model/config.json'));
