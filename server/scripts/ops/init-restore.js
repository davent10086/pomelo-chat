require('ts-node/register/transpile-only');
const { initDatabase, default: db } = require('../../src/infrastructure/database');
initDatabase().then(() => new Promise(resolve => db.end(resolve))).catch(error => {
  console.error('[restore] schema initialization failed:', error.code || error.message); db.end(); process.exitCode = 1;
});
