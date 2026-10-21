const path = require('node:path');
const { createRequire } = require('node:module');
const repoRoot = path.resolve(__dirname, '../..');
const serverRoot = path.join(repoRoot, 'server');
const serverRequire = createRequire(path.join(serverRoot, 'package.json'));
module.exports = { repoRoot, serverRoot, serverRequire };
