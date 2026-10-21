// @tags security regression
const { serverRequire, serverRoot: testServerRoot, repoRoot: testRepoRoot } = require("../../helpers/paths.cjs");
/** Real MySQL/Redis + HTTP/multipart regressions for the supplied defect reports. */
process.env.NODE_ENV = 'test';
if (!process.env.DATABASE_URL_TEST || !process.env.TEST_REDIS_KEY_PREFIX || !process.env.UPLOAD_ROOT)
  throw new Error('Run via run-isolated-tests.js regressions');
process.env.JWT_SECRET = 'report-regression-secret-for-tests';
process.env.MAX_UPLOAD_SIZE_BYTES = '32';
process.env.MAX_USER_UPLOAD_BYTES = '64';
process.env.MAX_USER_STORAGE_BYTES = '64';
process.env.MAX_USER_UPLOAD_SESSIONS = '2';
process.env.REQUEST_LOGS = 'false';
process.env.API_RATE_LIMIT_MAX = '2000';
serverRequire('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const express = serverRequire('express');
const expressWs = serverRequire('express-ws');
const jwt = serverRequire('jsonwebtoken');
const { initDatabase, closeDatabase } = require("../../../server/src/infrastructure/database");
const { Query } = require("../../../server/src/infrastructure/database-query");
const { better_chat } = require("../../../server/src/infrastructure/redis");
const { createRateLimiter } = require("../../../server/src/infrastructure/rate-limit");
const { collectExpiredUploads } = require("../../../server/src/modules/files/upload-policy");
const appModule = require("../../../server/src/controller/app");
const md5 = bytes => createHash('md5').update(bytes).digest('hex');
let server, limiterServer;
(async () => {
  await initDatabase();
  const username = 'reg_' + randomUUID().slice(0, 10);
  const inserted = await Query('INSERT INTO user (username,password,phone) VALUES (?,?,?)', [username, 'test-only', username]);
  const token = jwt.sign({ id: inserted.insertId, username }, process.env.JWT_SECRET);
  await better_chat.set(`token:${username}`, token, 'EX', 600);
  const { verifyTokensWithSessions } = require("../../../server/src/modules/identity/session");
  assert.deepEqual(await verifyTokensWithSessions([token, 'invalid-token']), [true, false], 'batched session checks retain signature and whitelist validation');
  server = http.createServer(appModule.default); expressWs(appModule.default, server); appModule.registerAppRoutes();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/chat/v1`;
  const request = async (route, body, options = {}) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }), ...options });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  assert.equal((await request('/ready')).status, 200);
  const ping = better_chat.ping; better_chat.ping = async () => { throw Error('injected dependency outage'); };
  assert.equal((await request('/ready')).status, 503); better_chat.ping = ping;
  for (const route of ['/friend/friend_id?id=1&id=2', '/friend/friend_id?id[a]=1', '/friend/friend_id?id=abc'])
    assert.equal((await request(route)).status, 400);
  assert.equal((await request('/auth/update_info', { phone: 'x'.repeat(51) })).status, 400);
  assert.equal((await request('/message/history?room=forbidden&type=group')).status, 403);
  assert.equal(await better_chat.get(`token:${username}`), token);
  const peerName = 'peer_' + randomUUID().slice(0, 10);
  const peer = await Query('INSERT INTO user(username,password,phone) VALUES (?,?,?)', [peerName, 'test-only', peerName]);
  const friendGroup = await Query('INSERT INTO friend_group(user_id,username,name) VALUES (?,?,?)', [inserted.insertId, username, 'presence']);
  await Query('INSERT INTO friend(owner_id,user_id,username,group_id,room,online_status) VALUES (?,?,?,?,?,?)', [inserted.insertId, peer.insertId, peerName, friendGroup.insertId, randomUUID(), 'online']);
  const { presenceObservers } = require("../../../server/src/modules/social/public");
  assert.deepEqual(await presenceObservers(peerName), [{ username }], 'presence refresh only targets actual contacts');
  assert.deepEqual(await presenceObservers(username), [], 'unrelated users do not receive presence refreshes');
  const friendState = async () => (await request('/friend/friend_list')).body.data[0];
  assert.equal((await friendState()).online_counts, 0, 'stale SQL online status is not authoritative');
  await better_chat.set(`presence:${peerName}`, 'remote-process', 'EX', 30);
  assert.equal((await friendState()).online_counts, 1, 'another process presence lease is visible');
  await better_chat.del(`presence:${peerName}`);
  assert.equal((await friendState()).online_counts, 0, 'expired or removed presence returns offline');
  const caseRoom = randomUUID();
  for (const id of ['CaseSensitive123', 'casesensitive123']) {
    await Query('INSERT INTO message(sender_id,receiver_id,room,type,media_type,content,client_msg_id) VALUES (?,?,?,?,?,?,?)', [inserted.insertId, peer.insertId, caseRoom, 'private', 'text', id, id]);
  }
  assert.equal((await Query('SELECT id FROM message WHERE room=?', [caseRoom])).length, 2, 'client message identifiers use case-sensitive uniqueness');
  const { createRtcCalls } = require("../../../server/src/modules/rtc/calls");
  const calls = createRtcCalls({ notifyUser: async () => {}, revokeMedia: async () => {} });
  const groupCall = await calls.createCall(randomUUID(), 'group', 'group_audio', username, [peerName]);
  await calls.transitionCall(groupCall.id, peerName, 'accept');
  await calls.transitionCall(groupCall.id, username, 'leave');
  assert.equal((await calls.getRoomCall('group', groupCall.room)).id, groupCall.id);
  assert.equal((await calls.transitionCall(groupCall.id, username, 'rejoin')).members[username], 'joined', 'former participant can rejoin an ongoing group call');
  await calls.transitionCall(groupCall.id, username, 'leave');
  const anotherCall = await calls.createCall(randomUUID(), 'private', 'private_audio', username, ['other_' + peerName]);
  await assert.rejects(() => calls.transitionCall(groupCall.id, username, 'rejoin'), /conflict|busy/i, 'rejoin cannot steal another call busy reservation');
  assert.equal(await better_chat.get(`rtc:busy:${username}`), anotherCall.id);
  await assert.rejects(() => calls.transitionCall(groupCall.id, 'outsider', 'rejoin'), /access denied/i);
  await calls.transitionCall(anotherCall.id, username, 'leave');
  await calls.transitionCall(groupCall.id, peerName, 'leave');
  assert.equal(await calls.getRoomCall('group', groupCall.room), null, 'ended call releases its room reservation');
  assert.equal((await request('/auth/login', { username, password: 'wrong' })).status, 400);
  const failures = [];
  for (let attempt = 0; attempt < 10; attempt++) failures.push(await request('/auth/login', { username: attempt % 2 ? username.toUpperCase() : username, password: 'wrong' }));
  assert.equal(failures.at(-1).status, 429, 'case aliases cannot bypass the stored-account limit');

  const verify = hash => request('/file/verify_file', { fileHash: hash, totalCount: 4, extname: 'txt' });
  const hash = md5(Buffer.alloc(32, 1)), v = await verify(hash); assert.equal(v.status, 200);
  const chunk = (hash, uploadToken, index, bytes) => {
    const form = new FormData(); form.set('chunk', new Blob([bytes], { type: 'text/plain' }), 'chunk');
    form.set('fileHash', hash); form.set('extname', '.TXT'); form.set('chunkIndex', String(index)); form.set('uploadToken', uploadToken);
    return request('/file/upload_chunk', form);
  };
  const parallel = await Promise.all([1, 2, 3, 4].map(index => chunk(hash, v.body.data.uploadToken, index, Buffer.alloc(16, 1))));
  assert.equal(parallel.filter(result => result.status === 200).length, 2);
  assert.equal(parallel.filter(result => result.status === 413).length, 2);
  const accepted = parallel.findIndex(result => result.status === 200) + 1;
  assert.equal((await chunk(hash.toUpperCase(), v.body.data.uploadToken, accepted, Buffer.alloc(16, 1))).status, 200, 'same canonical chunk retry consumes no extra budget');
  const quota = await better_chat.hvals(`upload:quota:${inserted.insertId}`);
  assert.equal(quota.reduce((sum, value) => sum + Number(value), 0), 32);
  assert.equal((await chunk(hash, v.body.data.uploadToken, accepted, Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413, 'multer size limit is a client error');
  await better_chat.del(`upload:session:${inserted.insertId}:${hash}:txt`);
  await collectExpiredUploads();
  assert.equal(await better_chat.hlen(`upload:quota:${inserted.insertId}`), 0, 'expired chunks release all reservations');

  const faultHash = md5(Buffer.alloc(16, 2)), faultSession = await verify(faultHash);
  const expire = better_chat.expire;
  better_chat.expire = async () => { throw Error('injected renewal failure after disk commit'); };
  try { assert.equal((await chunk(faultHash, faultSession.body.data.uploadToken, 1, Buffer.alloc(16, 2))).status, 500); }
  finally { better_chat.expire = expire; }
  assert.equal((await better_chat.hvals(`upload:quota:${inserted.insertId}`)).reduce((sum, value) => sum + Number(value), 0), 16, 'post-write Redis failure must not release bytes still on disk');
  await better_chat.del(`upload:session:${inserted.insertId}:${faultHash}:txt`); await collectExpiredUploads();

  const lostHash = md5(Buffer.alloc(16, 3)), lostSession = await verify(lostHash);
  const fs = require('node:fs/promises'), path = require('node:path');
  const write = fs.writeFile;
  let resume, entered;
  const blocked = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  fs.writeFile = async (name, ...args) => {
    if (String(name).includes(lostHash) && String(name).includes('.part-')) { entered(); await gate; }
    return write(name, ...args);
  };
  const delayed = chunk(lostHash, lostSession.body.data.uploadToken, 1, Buffer.alloc(16, 3));
  try {
    await blocked;
    const lock = `upload:session:${inserted.insertId}:${lostHash}:txt:lock`;
    await better_chat.set(lock, 'new-owner', 'PX', 120000);
    resume();
    assert.equal((await delayed).status, 500);
    assert.equal(await better_chat.get(lock), 'new-owner', 'stale owner cannot release a new lease');
    assert.equal(await fs.stat(path.join(process.env.UPLOAD_ROOT, String(inserted.insertId), 'file', `${lostHash}-txt`, 'chunk-1')).then(() => true).catch(() => false), false, 'stale writer cannot commit its staged chunk');
    await better_chat.del(lock);
  } finally { resume(); fs.writeFile = write; }
  await better_chat.del(`upload:session:${inserted.insertId}:${lostHash}:txt`); await collectExpiredUploads();

  const payload = Buffer.from('hello world!'), completeHash = md5(payload), ready = await verify(completeHash);
  for (let index = 1; index <= 4; index++) assert.equal((await chunk(completeHash, ready.body.data.uploadToken, index, payload.subarray((index - 1) * 3, index * 3))).status, 200);
  const merged = await request('/file/merge_chunk', { fileHash: completeHash, extname: 'txt', uploadToken: ready.body.data.uploadToken });
  assert.equal(merged.status, 200); assert.equal(await better_chat.hlen(`upload:quota:${inserted.insertId}`), 0);
  const media = await fetch(`http://127.0.0.1:${server.address().port}${merged.body.data.filePath}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(media.status, 200); assert.equal(await media.text(), payload.toString());
  const access = await request('/file/media_access', { path: merged.body.data.filePath });
  assert.equal(access.status, 200);
  const mediaBase = `http://127.0.0.1:${server.address().port}${merged.body.data.filePath}`;
  assert.equal((await fetch(`${mediaBase}?token=${encodeURIComponent(token)}`)).status, 401, 'login bearer is never accepted in media URLs');
  const accessUrl = `${mediaBase}?access=${access.body.data.access}`;
  const partial = await fetch(accessUrl, { headers: { Range: 'bytes=0-4' } });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), 'hello');
  assert.equal((await fetch(accessUrl, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(accessUrl.replace(completeHash, 'a'.repeat(32)))).status, 401, 'capability cannot be reused for another path');
  await better_chat.set(`token:${username}`, 'revoked');
  assert.equal((await fetch(accessUrl)).status, 401, 'revoking the login revokes media capabilities');
  await better_chat.set(`token:${username}`, token, 'EX', 600);
  await better_chat.del(`media:access:${access.body.data.access}`);
  assert.equal((await fetch(accessUrl)).status, 401, 'expired capabilities fail closed');

  const outbox = require("../../../server/src/modules/messaging/repository");
  const room = randomUUID();
  const conversation = await Query('INSERT INTO conversation(room,type,target_id) VALUES (?,?,?)', [room, 'private', inserted.insertId]);
  const message = await Query('INSERT INTO message(conversation_id,sender_id,receiver_id,room,type,media_type,content,room_seq) VALUES (?,?,?,?,?,?,?,?)', [conversation.insertId, inserted.insertId, inserted.insertId, room, 'private', 'text', 'retry', 1]);
  await Query('INSERT INTO message_outbox(message_id,conversation_id,attempts,claim_token) VALUES (?,?,?,?)', [message.insertId, conversation.insertId, 29, 'test-claim']);
  await outbox.retryOutboxClaim([message.insertId, 'test-claim']);
  assert.ok((await Query('SELECT failed_at FROM message_outbox WHERE message_id=?', [message.insertId]))[0].failed_at, 'bounded retries park the failed message for explicit recovery');
  assert.equal((await outbox.requeueFailedOutbox(message.insertId)).affectedRows, 1);
  assert.equal((await outbox.requeueFailedOutbox(message.insertId)).affectedRows, 0, 'only failed messages may be requeued');
  await Query('UPDATE message_outbox SET delivered_at=DATE_SUB(NOW(), INTERVAL 8 DAY) WHERE message_id=?', [message.insertId]);
  await outbox.pruneDeliveredOutbox(7);
  assert.equal((await Query('SELECT message_id FROM message_outbox WHERE message_id=?', [message.insertId])).length, 0);
  assert.equal((await Query('SELECT id FROM message WHERE id=?', [message.insertId])).length, 1, 'retention never deletes message history');

  const limiter = express(); limiter.use(createRateLimiter({ name: 'xff-regression', max: 2, windowSeconds: 60 })); limiter.get('/', (_req, res) => res.json({ ok: true }));
  limiterServer = limiter.listen(0, '127.0.0.1'); await once(limiterServer, 'listening');
  for (let index = 0; index < 4; index++) {
    const response = await fetch(`http://127.0.0.1:${limiterServer.address().port}/`, { headers: { 'X-Forwarded-For': `1.2.3.${index}, 9.9.9.9` } });
    assert.equal(response.status, index < 2 ? 200 : 429);
  }
  await require("./review-fixes.cjs")({ Query, request, verify, chunk, token, actor: { id: inserted.insertId, username }, base });
  console.log('[report-regressions] readiness, parser shapes, 403/session preservation, spoofed IPs, upload budgets, Redis failure, lease fencing, expiry, multipart 413, capability revocation/ranges and outbox recovery/retention passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await Promise.all([server, limiterServer].filter(Boolean).map(value => new Promise(resolve => { value.closeAllConnections(); value.close(resolve); })));
  better_chat.disconnect(); await closeDatabase();
});
