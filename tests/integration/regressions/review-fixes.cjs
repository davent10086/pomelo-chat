const { serverRequire, serverRoot: testServerRoot, repoRoot: testRepoRoot } = require("../../helpers/paths.cjs");
/** Focused real SQL/Redis regressions, run inside the isolated report suite. */
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const WebSocket = serverRequire('ws');
const md5 = bytes => createHash('md5').update(bytes).digest('hex');

module.exports = async ({ Query, request, verify, chunk, token, actor, base }) => {
  const { better_chat } = require("../../../server/src/infrastructure/redis");
  const peerName = 'private_' + randomUUID().slice(0, 10);
  const peer = await Query('INSERT INTO user(username,password,phone) VALUES (?,?,?)', [peerName, 'test-only', '13912345678']);
  await Query('INSERT INTO friend_group(user_id,username,name) VALUES (?,?,?)', [peer.insertId, peerName, 'default']);
  assert.equal((await request('/friend/add_friend', { id: peer.insertId, username: peerName })).status, 200);
  const [friend] = await Query('SELECT id, room FROM friend WHERE owner_id=? AND user_id=?', [actor.id, peer.insertId]);
  const detail = (await request(`/friend/friend_id?id=${friend.id}`)).body.data;
  assert.equal(detail.username, peerName, 'ordinary friend details remain available');
  assert.equal(Object.hasOwn(detail, 'phone'), false, 'adding a contact never discloses their private phone');
  assert.equal(JSON.stringify(detail).includes('13912345678'), false);

  const messaging = require("../../../server/src/modules/messaging/queries");
  const history = messaging.fetchHistoryMessages;
  const sockets = [];
  let historyReads = 0;
  messaging.fetchHistoryMessages = async (...args) => { historyReads++; return history(...args); };
  const connect = () => new Promise((resolve, reject) => {
    const url = base.replace('http:', 'ws:') + `/message/connect_chat?id=${actor.id}&room=${friend.room}&type=private`;
    const ws = new WebSocket(url, ['pomelo-token', token]); sockets.push(ws);
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('WS admission timed out')); }, 10000);
    ws.once('error', error => { clearTimeout(timeout); reject(error); });
    ws.once('close', () => { clearTimeout(timeout); resolve(null); });
    ws.on('message', frame => {
      if (JSON.parse(frame.toString()).name === 'history') { clearTimeout(timeout); resolve(ws); }
    });
  });
  try {
    const accepted = (await Promise.all(Array.from({ length: 100 }, connect))).filter(Boolean);
    assert.equal(accepted.length, 3, 'only the configured per-room connections are admitted');
    assert.equal(historyReads, 3, 'rejected connections never query history');
    const closed = once(accepted[0], 'close'); accepted[0].close(); await closed;
    const leaseKey = `chat:connections:${actor.id}:${friend.room}`;
    for (let i = 0; i < 100 && await better_chat.zcard(leaseKey) !== 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(await connect(), 'a closed connection releases its slot');
  } finally {
    messaging.fetchHistoryMessages = history;
    for (const ws of sockets) ws.terminate();
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  // Separate module instances share Redis admission, as separate server workers do.
  const firstWorker = require("../../../server/src/modules/realtime/chat-admission");
  delete require.cache[require.resolve("../../../server/src/modules/realtime/chat-admission")];
  const secondWorker = require("../../../server/src/modules/realtime/chat-admission");
  class Socket extends EventEmitter { readyState = 1; close() { this.readyState = 3; this.emit('close'); } }
  const workerSockets = Array.from({ length: 20 }, () => new Socket());
  try {
    const admitted = await Promise.all(workerSockets.map((ws, index) =>
      (index % 2 ? firstWorker : secondWorker).admitChatSocket(ws, 'test-worker-' + actor.id, `room-${index}`)));
    assert.equal(admitted.filter(Boolean).length, 8, 'the user limit spans rooms and worker instances');
  } finally { workerSockets.forEach(ws => ws.close()); }

  const files = require("../../../server/src/modules/files/repository");
  const upload = async bytes => {
    const hash = md5(bytes), verified = await verify(hash);
    assert.equal(verified.status, 200);
    for (let index = 1; index <= 4; index++) {
      const size = bytes.length / 4;
      assert.equal((await chunk(hash, verified.body.data.uploadToken, index, bytes.subarray((index - 1) * size, index * size))).status, 200);
    }
    return { hash, uploadToken: verified.body.data.uploadToken };
  };
  const merge = value => request('/file/merge_chunk', { fileHash: value.hash, extname: 'txt', uploadToken: value.uploadToken });
  const recoverable = await upload(Buffer.alloc(16, 7));
  const finalPath = path.join(process.env.UPLOAD_ROOT, String(actor.id), 'file', recoverable.hash + '.txt');
  await fs.writeFile(finalPath + '.merge.lock', '', { flag: 'wx' });
  const upsert = files.upsertReadyFile;
  files.upsertReadyFile = async () => { throw new Error('injected metadata failure after rename'); };
  try { assert.equal((await merge(recoverable)).status, 500); }
  finally { files.upsertReadyFile = upsert; }
  assert.equal(await fs.stat(finalPath).then(() => true), true, 'old crash lock cannot block a new merge');
  assert.equal(await fs.stat(finalPath + '.merge.lock').then(() => true).catch(() => false), false);
  assert.equal((await Query('SELECT status,size FROM file_metadata WHERE owner_id=? AND file_hash=?', [actor.id, recoverable.hash]))[0].size, 16, 'bytes remain reserved after metadata failure');
  assert.equal((await merge(recoverable)).status, 200, 'retry registers the existing file and cleans the session');
  assert.equal(await better_chat.hlen(`upload:quota:${actor.id}`), 0);

  const a = await upload(Buffer.alloc(32, 8)), b = await upload(Buffer.alloc(32, 9));
  const merges = await Promise.all([merge(a), merge(b)]);
  assert.deepEqual(merges.map(item => item.status).sort(), [200, 413], 'concurrent different files cannot overspend cumulative storage');
  const stored = (await Query('SELECT SUM(size) AS total FROM file_metadata WHERE owner_id=?', [actor.id]))[0].total;
  assert.equal(Number(stored), 60, 'completed files stay charged after temporary quota is released');
  const winner = merges[0].status === 200 ? a : b;
  assert.equal((await verify(winner.hash)).body.code, 6001, 'existing files remain readable without double charging');
  const rejected = merges[0].status === 413 ? a : b;
  await better_chat.del(`upload:session:${actor.id}:${rejected.hash}:txt`);
  await require("../../../server/src/modules/files/upload-policy").collectExpiredUploads();
  assert.equal(Number((await Query('SELECT SUM(size) AS total FROM file_metadata WHERE owner_id=?', [actor.id]))[0].total), 60);
  const abandoned = await upload(Buffer.alloc(4, 10));
  await files.reserveFileStorage([actor.id, abandoned.hash, 'txt', 'file', `/uploads/${actor.id}/file/${abandoned.hash}.txt`, 4, null]);
  await better_chat.del(`upload:session:${actor.id}:${abandoned.hash}:txt`);
  await require("../../../server/src/modules/files/upload-policy").collectExpiredUploads();
  assert.equal((await Query('SELECT id FROM file_metadata WHERE owner_id=? AND file_hash=?', [actor.id, abandoned.hash])).length, 0, 'expired pre-rename reservations recover their durable budget');
  const last = await upload(Buffer.alloc(4, 11));
  assert.equal((await merge(last)).status, 200);
  await better_chat.del(`upload:quota:${actor.id}`);
  const overBudget = await upload(Buffer.alloc(4, 12));
  assert.equal((await merge(overBudget)).status, 413, 'Redis eviction cannot free completed-file storage budget');

  const db = require("../../../server/src/infrastructure/database-query");
  const actions = require("../../../server/src/modules/assistant/actions");
  const memory = await Query('INSERT INTO assistant_memory(user_id,category,content) VALUES (?,?,?)', [actor.id, 'preference', 'transactional deletion']);
  const pending = await actions.createPendingAction(actor.id, 'forget_memory', { id: memory.insertId });
  const withTransaction = db.withTransaction;
  db.withTransaction = work => withTransaction(executor => work(async (sql, bindings) => {
    if (sql.includes("SET status = 'completed'")) throw new Error('injected receipt failure');
    return executor(sql, bindings);
  }));
  try { assert.equal((await actions.confirmAction(actor, { confirmationId: pending.confirmationId })).code, 1001); }
  finally { db.withTransaction = withTransaction; }
  assert.equal((await Query('SELECT id FROM assistant_memory WHERE id=?', [memory.insertId])).length, 1, 'real SQL rollback restores memory after receipt failure');
  assert.equal((await actions.confirmAction({ id: peer.insertId }, { confirmationId: pending.confirmationId })).code, 1007);
  assert.equal((await actions.confirmAction(actor, { confirmationId: pending.confirmationId })).data.status, 'completed');
  assert.equal((await actions.confirmAction(actor, { confirmationId: pending.confirmationId })).data.alreadyConfirmed, true);
  assert.equal((await Query('SELECT id FROM assistant_memory WHERE id=?', [memory.insertId])).length, 0);

  const { createRtcCalls } = require("../../../server/src/modules/rtc/calls");
  const applied = [];
  let failMedia = false;
  const calls = createRtcCalls({ notifyUser: async () => {}, revokeMedia: async state => {
    if (failMedia) throw new Error('injected SFU outage');
    applied.push(state);
  } });
  const call = await calls.createCall(randomUUID(), 'private', 'private_audio', actor.username, [peerName]);
  await calls.transitionCall(call.id, peerName, 'accept');
  failMedia = true;
  await assert.rejects(calls.transitionCall(call.id, actor.username, 'leave'), /injected SFU outage/);
  assert.equal((await calls.getCall(call.id)).status, 'ended');
  assert.ok(await better_chat.hget('rtc:media-revocations', call.id), 'SFU cleanup survives a failed request and worker restart');
  failMedia = false;
  const restarted = createRtcCalls({ notifyUser: async () => {}, revokeMedia: async state => applied.push(state) });
  await restarted.transitionCall(call.id, actor.username, 'leave');
  assert.equal(applied.at(-1).status, 'ended', 'repeating an ended transition retries pending media cleanup');
  assert.equal(await better_chat.hget('rtc:media-revocations', call.id), null);
  await assert.rejects(restarted.transitionCall(call.id, 'outsider', 'leave'), /access denied/);
  console.log('[review-fixes] phone privacy, 100 WS connections/history budget, shared admission, stale merge lock, durable storage quota/races, real SQL deletion rollback and durable SFU cleanup passed');
};
