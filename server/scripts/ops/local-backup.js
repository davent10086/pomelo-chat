/** Offline local-disk backup. Never restores into an existing database or directory. */
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const readline = require('node:readline');
const mysql = require('mysql2');

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_]+$/.test(value);
const databaseName = value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
const within = (root, relative) => {
  if (typeof relative !== 'string' || relative.includes('\\') || path.isAbsolute(relative)) throw new Error('Invalid backup path');
  const file = path.resolve(root, relative);
  if (file === root || !file.startsWith(path.resolve(root) + path.sep)) throw new Error('Backup path escapes root');
  return file;
};
async function checksum(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function mkdirNew(directory) { await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory, { mode: 0o700 }); }
async function regular(file) { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Backup requires regular files'); return stat; }
async function walk(root, relative = '') {
  const entries = [];
  const rootStat = await fs.lstat(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Backup requires a real directory');
  for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = relative ? `${relative}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error('Symlinks are not supported in local backups');
    if (item.isDirectory()) entries.push(...await walk(root, next));
    else if (item.isFile()) entries.push(next);
    else throw new Error('Unsupported upload entry');
  }
  return entries;
}
function connection(options, database) { return mysql.createConnection({ ...options, database, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false }); }
async function end(raw) { await raw.promise().end(); }
const columns = async (db, table) => (await db.query('SHOW COLUMNS FROM ??', [table]))[0].map(row => ({ name: row.Field, type: row.Type, nullable: row.Null }));

async function createBackup({ options, database, uploadRoot, output, offline }) {
  if (!offline) throw new Error('Stop all writers/workers, then pass --offline');
  if (!databaseName(database)) throw new Error('Invalid source database');
  output = path.resolve(output); uploadRoot = path.resolve(uploadRoot);
  if (output === uploadRoot || output.startsWith(uploadRoot + path.sep) || uploadRoot.startsWith(output + path.sep)) throw new Error('Backup and upload directories must be separate');
  const uploads = (await walk(uploadRoot).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).filter(file => file !== '.restore-complete.json'); await mkdirNew(output); await fs.mkdir(path.join(output, 'tables')); await fs.mkdir(path.join(output, 'uploads'));
  const raw = connection(options, database), db = raw.promise();
  const manifest = { version: 1, sourceDatabase: database, createdAt: new Date().toISOString(), timezone: '+00:00', offline: true, tables: [], files: [] };
  const references = [];
  try {
    await db.query("SET time_zone = '+00:00'");
    const [engines] = await db.query("SELECT TABLE_NAME,ENGINE,TABLE_TYPE FROM information_schema.tables WHERE TABLE_SCHEMA=?", [database]);
    if (engines.some(row => row.TABLE_TYPE !== 'BASE TABLE' || row.ENGINE !== 'InnoDB')) throw new Error('Only InnoDB base tables are supported');
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    for (const entry of engines.sort((a, b) => a.TABLE_NAME.localeCompare(b.TABLE_NAME))) {
      const name = entry.TABLE_NAME; if (!identifier(name)) throw new Error('Unsupported table name');
      const table = { name, columns: await columns(db, name), file: `tables/${name}.jsonl`, rows: 0, sha256: '' };
      const target = within(output, table.file);
      await pipeline(raw.query('SELECT * FROM ??', [name]).stream({ highWaterMark: 8 }), async function* (rows) {
        for await (const row of rows) {
          table.rows++;
          if (name === 'file_metadata' && row.status === 'ready') references.push(row.storage_path);
          yield JSON.stringify(row) + '\n';
        }
      }, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
      table.sha256 = await checksum(target); manifest.tables.push(table);
    }
    await db.query('COMMIT');
    for (const relative of uploads) {
      const source = within(uploadRoot, relative), target = within(path.join(output, 'uploads'), relative);
      await regular(source); await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target, require('node:fs').constants.COPYFILE_EXCL); await fs.chmod(target, 0o600);
      const stat = await regular(target); manifest.files.push({ path: relative, size: stat.size, sha256: await checksum(target) });
    }
    const stored = new Set(manifest.files.map(file => '/uploads/' + file.path));
    if (references.some(file => !stored.has(file))) throw new Error('A ready attachment is missing from the local upload directory');
    // The manifest is a completion marker. Partial backups cannot be restored.
    await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    return manifest;
  } catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { await end(raw); }
}

async function verifyBackup(input) {
  const root = path.resolve(input); await regular(path.join(root, 'manifest.json'));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.offline !== true || !databaseName(manifest.sourceDatabase) || !Array.isArray(manifest.tables) || !Array.isArray(manifest.files) || !manifest.tables.length) throw new Error('Invalid backup manifest');
  const names = new Set();
  for (const table of manifest.tables) {
    if (!identifier(table.name) || names.has(table.name) || table.file !== `tables/${table.name}.jsonl` || !Number.isSafeInteger(table.rows) || table.rows < 0 || !Array.isArray(table.columns) || !table.columns.length || table.columns.some(c => !identifier(c.name) || typeof c.type !== 'string')) throw new Error('Invalid backup table');
    names.add(table.name); const file = within(root, table.file); await regular(file);
    if (await checksum(file) !== table.sha256) throw new Error('Table checksum mismatch');
  }
  const files = new Set();
  for (const entry of manifest.files) {
    const file = within(path.join(root, 'uploads'), entry.path); if (files.has(entry.path)) throw new Error('Duplicate backup path'); files.add(entry.path);
    const stat = await regular(file);
    if (stat.size !== entry.size || await checksum(file) !== entry.sha256) throw new Error('Upload checksum mismatch');
  }
  // Reject symlinked intermediate directories, not just leaf files.
  await walk(root);
  return manifest;
}

async function restoreBackup({ options, input, database, uploads, offline, initialize }) {
  if (!offline || !/^pomelo_restore_[a-zA-Z0-9_]+$/.test(database)) throw new Error('Restore requires --offline and a new pomelo_restore_* database');
  const manifest = await verifyBackup(input);
  if (database === manifest.sourceDatabase) throw new Error('Cannot overwrite the source database');
  const destination = path.resolve(uploads);
  try { await fs.lstat(destination); throw new Error('Restore upload directory already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const admin = connection(options), adminDb = admin.promise();
  try { await adminDb.query('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [database]); }
  finally { await end(admin); }
  // Schema comes from this checked-out application, never SQL embedded in the backup.
  await initialize(database);
  const raw = connection(options, database), db = raw.promise();
  try {
    await db.query("SET time_zone = '+00:00'");
    const [tables] = await db.query('SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA=?', [database]);
    if (tables.length !== manifest.tables.length) throw new Error('Backup schema does not match this application version');
    for (const table of manifest.tables) if (JSON.stringify(await columns(db, table.name)) !== JSON.stringify(table.columns)) throw new Error('Restore column schema mismatch');
    await db.query('SET FOREIGN_KEY_CHECKS=0'); await db.beginTransaction();
    for (const table of manifest.tables) {
      await db.query('DELETE FROM ??', [table.name]);
      const lines = readline.createInterface({ input: createReadStream(within(path.resolve(input), table.file)), crlfDelay: Infinity });
      let batch = [], count = 0;
      const flush = async () => { if (batch.length) await db.query('INSERT INTO ?? (??) VALUES ?', [table.name, table.columns.map(c => c.name), batch]); batch = []; };
      for await (const line of lines) {
        const row = JSON.parse(line); if (Object.keys(row).length !== table.columns.length || table.columns.some(c => !Object.hasOwn(row, c.name))) throw new Error('Invalid backup row');
        batch.push(table.columns.map(c => {
          const value = row[c.name];
          if (/^(?:varbinary|binary|.*blob)/i.test(c.type) && value?.type === 'Buffer') return Buffer.from(value.data);
          if (/^json$/i.test(c.type) && value !== null && typeof value === 'object') return JSON.stringify(value);
          return value;
        })); count++; if (batch.length === 100) await flush();
      }
      await flush(); if (count !== table.rows) throw new Error('Restore row count mismatch');
    }
    const [foreignKeys] = await db.query(`SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME
      FROM information_schema.key_column_usage WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL`, [database]);
    for (const key of foreignKeys) {
      const [orphans] = await db.query('SELECT 1 FROM ?? c LEFT JOIN ?? p ON c.??=p.?? WHERE c.?? IS NOT NULL AND p.?? IS NULL LIMIT 1',
        [key.TABLE_NAME, key.REFERENCED_TABLE_NAME, key.COLUMN_NAME, key.REFERENCED_COLUMN_NAME, key.COLUMN_NAME, key.REFERENCED_COLUMN_NAME]);
      if (orphans.length) throw new Error('Restore foreign-key audit failed');
    }
    await db.commit(); await db.query('SET FOREIGN_KEY_CHECKS=1');
    await mkdirNew(destination);
    for (const entry of manifest.files) {
      const target = within(destination, entry.path); await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(within(path.join(path.resolve(input), 'uploads'), entry.path), target, require('node:fs').constants.COPYFILE_EXCL); await fs.chmod(target, 0o600);
      if (await checksum(target) !== entry.sha256) throw new Error('Restored upload verification failed');
    }
    await fs.writeFile(path.join(destination, '.restore-complete.json'), JSON.stringify({ restoredAt: new Date().toISOString(), database }), { flag: 'wx', mode: 0o600 });
    return manifest;
  } catch (error) { await db.rollback().catch(() => undefined); throw error; }
  finally { await end(raw); }
}
module.exports = { createBackup, verifyBackup, restoreBackup };
