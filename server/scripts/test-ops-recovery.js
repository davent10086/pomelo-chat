const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const mysql = require('mysql2/promise');
const { createBackup, restoreBackup, verifyBackup } = require('./ops/local-backup');
const { initialize } = require('./ops/backup-local');
if (!process.env.DATABASE_URL_TEST || !process.env.UPLOAD_ROOT) throw new Error('Use the isolated ops runner');
require('ts-node/register/transpile-only');
const { initDatabase, default: pool } = require('../src/infrastructure/database');
const { Query } = require('../src/infrastructure/database-query');
const target = new URL(process.env.DATABASE_URL_TEST);
const options = { host: target.hostname, port: Number(target.port || 3306), user: decodeURIComponent(target.username), password: decodeURIComponent(target.password) };
const source = decodeURIComponent(target.pathname.slice(1));
const restored = `pomelo_restore_test_${Date.now()}_${process.pid}`;
let temp, admin;
(async () => {
  try {
    await initDatabase(); admin = await mysql.createConnection(options);
    const parent = path.dirname(process.env.UPLOAD_ROOT); temp = await fs.mkdtemp(path.join(parent, 'ops-'));
    const output = path.join(temp, 'snapshot'), destination = path.join(temp, 'restored-uploads');
    const result = await Query("INSERT INTO user(username,password,phone) VALUES('restore_fixture','not-used-for-login','13000000001')");
    const id = result.insertId, bytes = Buffer.from('local backup\n恢复附件✓'), hash = createHash('sha256').update(bytes).digest('hex');
    const relative = `${id}/file/${hash}.txt`, disk = path.join(process.env.UPLOAD_ROOT, relative);
    await fs.mkdir(path.dirname(disk), { recursive: true }); await fs.writeFile(disk, bytes);
    await Query("INSERT INTO file_metadata(owner_id,file_hash,ext,media_type,storage_path,size,status) VALUES(?,?,'txt','file',?,?,'ready')", [id, hash, '/uploads/' + relative, bytes.length]);
    await Query("INSERT INTO assistant_task(user_id,title,status) VALUES(?,'restore durable task','open')", [id]);
    await Query("INSERT INTO assistant_action(id,user_id,type,payload,selection,status,expires_at) VALUES('restore-json',?,'send_message',?,?,'pending',DATE_ADD(NOW(),INTERVAL 1 DAY))", [id, JSON.stringify({ content: '中文\nJSON', flags: [true, false] }), JSON.stringify([0, 2])]);
    const input = { options, database: source, uploadRoot: process.env.UPLOAD_ROOT, output, offline: true };
    await assert.rejects(() => createBackup({ ...input, output: path.join(temp, 'not-offline'), offline: false }), /offline/);
    await assert.rejects(() => createBackup({ ...input, output: path.join(process.env.UPLOAD_ROOT, 'recursive') }), /separate/);
    const manifest = await createBackup(input); assert.equal(manifest.files.length, 1); await verifyBackup(output);
    const first = path.join(output, manifest.tables[0].file), original = await fs.readFile(first);
    await fs.appendFile(first, 'tampered'); await assert.rejects(() => verifyBackup(output), /checksum/); await fs.writeFile(first, original);
    const restore = { options, input: output, database: restored, uploads: destination, offline: true, initialize: name => initialize(name, options) };
    await assert.rejects(() => restoreBackup({ ...restore, database: source }), /pomelo_restore/);
    await restoreBackup(restore);
    const connection = await mysql.createConnection({ ...options, database: restored, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
    try {
      const [[user]] = await connection.query('SELECT username FROM user WHERE id=?', [id]); assert.equal(user.username, 'restore_fixture');
      const [[task]] = await connection.query('SELECT title FROM assistant_task WHERE user_id=?', [id]); assert.equal(task.title, 'restore durable task');
      const [[action]] = await connection.query("SELECT payload,selection FROM assistant_action WHERE id='restore-json'");
      assert.deepEqual(action.payload, { content: '中文\nJSON', flags: [true, false] }); assert.deepEqual(action.selection, [0, 2]);
      for (const table of manifest.tables) { const [[count]] = await connection.query('SELECT COUNT(*) AS n FROM ??', [table.name]); assert.equal(Number(count.n), table.rows, `${table.name} row count changed`); }
    } finally { await connection.end(); }
    assert.deepEqual(await fs.readFile(path.join(destination, relative)), bytes);
    const repeated = await createBackup({ ...input, database: restored, uploadRoot: destination, output: path.join(temp, 'second-snapshot') });
    assert.equal(repeated.files.length, 1, 'Restore marker must not poison the next restore cycle');
    await assert.rejects(() => restoreBackup(restore), /already exists/);
    const manifestFile = path.join(output, 'manifest.json'), saved = await fs.readFile(manifestFile);
    manifest.files[0].path = '../escape.txt'; await fs.writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(() => verifyBackup(output), /escapes root/); await fs.writeFile(manifestFile, saved);
    console.log('[ops-recovery] checksummed snapshot, new-target restore, row/foreign-key/file audits, corruption, traversal and overwrite guards passed');
  } finally {
    if (admin) { if (!/^pomelo_restore_test_\d+_\d+$/.test(restored)) throw new Error('Unsafe restore test cleanup'); await admin.query('DROP DATABASE IF EXISTS ??', [restored]); await admin.end(); }
    await new Promise(resolve => pool.end(resolve));
    if (temp) { if (path.dirname(temp) !== path.dirname(process.env.UPLOAD_ROOT) || !path.basename(temp).startsWith('ops-')) throw new Error('Unsafe recovery directory cleanup'); await fs.rm(temp, { recursive: true, force: true }); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
