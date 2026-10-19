const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { createBackup, verifyBackup, restoreBackup } = require('./local-backup');
const server = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(server, '.env'), quiet: true });
function argument(name) { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; }
async function initialize(database, options) {
  const env = { ...process.env, NODE_ENV: 'production', APP_ENV: 'production', DATABASE_URL_TEST: '', TEST_DATABASE_URL: '', DB_NAME: database,
    DB_HOST: options.host, DB_PORT: String(options.port), DB_USER: options.user, DB_PASSWORD: options.password, TS_NODE_FILES: 'true' };
  const child = spawn(process.execPath, [path.join(__dirname, 'init-restore.js')], { cwd: server, env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  if (code !== 0) throw new Error('Restore schema initialization failed');
}
async function main() {
  const operation = process.argv[2], offline = process.argv.includes('--offline');
  const options = { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' };
  if (operation === 'verify') { if (!argument('--input')) throw new Error('Missing --input'); await verifyBackup(argument('--input')); console.log('[backup] checksums verified'); return; }
  if (operation === 'create') {
    if (!argument('--output')) throw new Error('Missing --output');
    const manifest = await createBackup({ options, database: process.env.DB_NAME || 'pomelo-chat', uploadRoot: process.env.UPLOAD_ROOT || path.join(server, 'uploads'), output: argument('--output'), offline });
    if (process.env.BACKUP_STATUS_FILE) {
      const file = path.resolve(process.env.BACKUP_STATUS_FILE), temporary = file + '.part-' + process.pid;
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(temporary, JSON.stringify({ lastSuccess: Date.parse(manifest.createdAt) / 1000 }), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file);
    }
    console.log('[backup] completed and checksummed'); return;
  }
  if (operation === 'restore') {
    if (!argument('--input') || !argument('--database') || !argument('--uploads')) throw new Error('Restore requires --input, --database and --uploads');
    await restoreBackup({ options, input: argument('--input'), database: argument('--database'), uploads: argument('--uploads'), offline, initialize: name => initialize(name, options) });
    console.log('[restore] database, foreign keys and local file checksums verified; Redis sessions were not restored'); return;
  }
  throw new Error('Expected create, verify or restore');
}
if (require.main === module) main().catch(error => { console.error('[backup]', error.code || error.message); process.exitCode = 1; });
module.exports = { initialize };
