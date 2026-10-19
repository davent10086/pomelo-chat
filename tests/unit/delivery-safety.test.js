const path = require('node:path');
process.env.TS_NODE_PROJECT = path.resolve(__dirname, '../../server/tsconfig.json');
require('../../server/node_modules/ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const repository = require('../../server/src/modules/messaging/repository');
const social = require('../../server/src/modules/social/repository');
const queries = require('../../server/src/infrastructure/database-query');
const { renderMessageMetrics } = require('../../server/src/infrastructure/message-metrics');
const { better_chat } = require('../../server/src/infrastructure/redis');
const { MessageOutboxWorker } = require('../../server/src/modules/messaging/outbox');
const { registerSessionSocket } = require('../../server/src/modules/realtime/session-sockets');
const delivery = require('../../server/src/modules/realtime/message-delivery');
const { fanoutPublisher, publishFanout } = require('../../server/src/modules/realtime/fanout-publisher');

const tick = () => new Promise(resolve => setImmediate(resolve));
const metric = name => Number(new RegExp(`^${name} (\\d+)`, 'm').exec(renderMessageMetrics())?.[1] || 0);
function patch(t, object, changes) {
  for (const [key, value] of Object.entries(changes)) {
    const original = object[key]; object[key] = value;
    t.after(() => { object[key] = original; });
  }
}
function socket(room, type, userId = 2, valid = true) {
  const ws = new EventEmitter(); Object.assign(ws, { readyState: 1, bufferedAmount: 0, frames: [] });
  ws.send = (raw, callback) => { ws.frames.push(JSON.parse(raw)); callback?.(); };
  ws.close = code => { ws.closeCode = code; ws.readyState = 3; ws.emit('close'); };
  ws.terminate = () => ws.close(1006);
  registerSessionSocket(ws, `user-${userId}`, 'token', async () => valid ? { id: userId } : null);
  delivery.ChatRooms[room] ||= {};
  delivery.ChatRooms[room][`${userId}:test`] = { ws, userId, type };
  return ws;
}
function cleanRooms(t) {
  t.after(async () => {
    for (const room of Object.values(delivery.ChatRooms)) for (const { ws } of Object.values(room)) ws.close(1000);
    for (const room of Object.keys(delivery.ChatRooms)) delete delivery.ChatRooms[room];
    await delivery.stopMessageDelivery();
  });
}

test('ordinary local/foreign fanout rechecks group and private membership, before receipts', async t => {
  cleanRooms(t);
  let allowed = true;
  patch(t, social, { findAccessibleGroupRoom: async () => allowed ? [{ id: 10 }] : [],
    findAccessiblePrivateRoom: async () => allowed ? [{ user_id: 1 }] : [] });
  const group = socket('group-room', 'group'), privateWs = socket('private-room', 'private');
  const body = { id: 10, room_seq: 1, sender_id: 1, receiver_id: 10, type: 'image', content: '/uploads/image' };
  await delivery.sendLocalRoom('group-room', body);
  await delivery.sendLocalRoom('private-room', body);
  assert.equal(group.frames.length, 1); assert.equal(privateWs.frames.length, 1);
  allowed = false;
  const receipts = metric('pomelo_delivery_receipts_requested_total');
  await delivery.sendLocalRoom('private-room', { ...body, id: 11, room_seq: 2 });
  assert.equal(privateWs.frames.length, 1); assert.equal(privateWs.closeCode, 4003);
  const subscriber = new EventEmitter(); subscriber.subscribe = async () => {}; subscriber.disconnect = () => {};
  patch(t, better_chat, { duplicate: () => subscriber });
  await delivery.subscribeRoomFanout();
  subscriber.emit('message', 'channel', JSON.stringify({ instanceId: 'another-instance', room: 'group-room', message: { ...body, id: 11, room_seq: 2 } }));
  await tick();
  assert.equal(group.frames.length, 1); assert.equal(group.closeCode, 4003);
  assert.equal(metric('pomelo_delivery_receipts_requested_total'), receipts);
  assert.equal(delivery.ChatRooms['group-room'], undefined);
});

test('lookup failure and revoked login fail closed; private read receipts still work', async t => {
  cleanRooms(t);
  const ws = socket('private', 'private');
  patch(t, social, { findAccessiblePrivateRoom: async () => [{ user_id: 1 }] });
  await delivery.sendLocalRoom('private', { name: 'read_receipt', room: 'private', userId: 1, roomSeq: 2 });
  assert.equal(ws.frames[0].name, 'read_receipt');
  social.findAccessiblePrivateRoom = async () => { throw Error('injected authorization lookup failure'); };
  await delivery.sendLocalRoom('private', { id: 1, room_seq: 1, sender_id: 1, content: 'blocked' });
  assert.equal(ws.frames.length, 1);
  assert.equal(ws.closeCode, 1013, 'lookup outage must trigger reconnect/history recovery');
  const revoked = socket('revoked', 'private', 3, false);
  await delivery.sendLocalRoom('revoked', { id: 2, sender_id: 1, content: 'blocked' });
  assert.equal(revoked.frames.length, 0); assert.equal(revoked.closeCode, 4001);
});

test('late async fanout and equal-sequence retries do not regress a socket', async t => {
  cleanRooms(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  patch(t, social, { findAccessibleGroupRoom: async () => { if (++calls === 1) await gate; return [{ id: 10 }]; } });
  const ws = socket('ordered', 'group');
  const message = { id: 1, room_seq: 1, sender_id: 1, content: 'first' };
  const first = delivery.sendLocalRoom('ordered', message);
  await tick();
  await delivery.sendLocalRoom('ordered', { ...message, id: 2, room_seq: 2 });
  release(); await first;
  await delivery.sendLocalRoom('ordered', { ...message, id: 2, room_seq: 2 });
  assert.deepEqual(ws.frames.map(frame => frame.room_seq), [2]);
});

function fakeOutbox(t) {
  let taken = false, token, owns = true;
  const state = { renewals: 0, completions: 0, retries: 0, completeAffected: 1 };
  patch(t, queries, { withTransaction: async fn => fn() });
  patch(t, repository, {
    lockAvailableOutboxHead: async () => { if (taken) return []; taken = true; return [{ message_id: 1 }]; },
    claimOutboxRows: async ([value]) => { token = value; return { affectedRows: 1 }; },
    renewOutboxLease: async (_args) => { state.renewals++; return { affectedRows: owns ? 1 : 0 }; },
    completeOutboxClaim: async () => { state.completions++; return { affectedRows: state.completeAffected }; },
    retryOutboxClaim: async ([, value]) => { assert.equal(value, token); state.retries++; return { affectedRows: owns ? 1 : 0 }; }
  });
  state.lose = () => { owns = false; };
  return state;
}

test('lost lease aborts paused delivery and never counts a stale completion', async t => {
  const state = fakeOutbox(t), before = metric('pomelo_outbox_dispatch_completed_total');
  let release, entered, heartbeat;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const interval = global.setInterval;
  patch(t, global, { setInterval: (fn, ms, ...args) => { if (ms === 20000) heartbeat = fn; return interval(fn, ms, ...args); } });
  let sends = 0;
  const worker = new MessageOutboxWorker(async (_id, context) => { entered(); await gate; await context.assertLease(); sends++; });
  worker.start(); const running = worker.flush();
  await started; state.lose(); heartbeat(); await running;
  release(); await tick(); await worker.stop();
  assert.equal(sends, 0); assert.equal(state.completions, 0); assert.equal(state.retries, 1);
  assert.equal(metric('pomelo_outbox_dispatch_completed_total'), before);
});

test('zero-row completion is not success', async t => {
  const state = fakeOutbox(t), before = metric('pomelo_outbox_dispatch_completed_total');
  state.completeAffected = 0;
  const worker = new MessageOutboxWorker(async (_id, context) => { context.checkActive(); });
  worker.start(); await worker.flush(); await worker.stop();
  assert.equal(state.completions, 1); assert.equal(state.retries, 1);
  assert.equal(metric('pomelo_outbox_dispatch_completed_total'), before);
});

test('renewal failure fails closed before the handler; stop aborts a pending handler', async t => {
  const state = fakeOutbox(t);
  const renew = repository.renewOutboxLease;
  repository.renewOutboxLease = async () => { throw Error('injected SQL outage'); };
  let sends = 0;
  const first = new MessageOutboxWorker(async () => { sends++; });
  first.start(); await first.flush(); await first.stop();
  assert.equal(sends, 0); assert.equal(state.completions, 0);
  repository.renewOutboxLease = renew;
  // The next worker has an independent claim fixture.
  repository.lockAvailableOutboxHead = async () => [];
  let once = false;
  repository.lockAvailableOutboxHead = async () => { if (once) return []; once = true; return [{ message_id: 1 }]; };
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const second = new MessageOutboxWorker(async (_id, context) => { entered(); await gate; context.checkActive(); sends++; });
  second.start(); const work = second.flush(); await started;
  await second.stop(); await work;
  release(); await tick();
  assert.equal(sends, 0); assert.equal(state.completions, 0);
});

test('process pause past the local lease deadline cancels even before the next heartbeat', async t => {
  fakeOutbox(t);
  let now = 0, entered, release;
  patch(t, global, { performance: { now: () => now } });
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let sends = 0;
  const worker = new MessageOutboxWorker(async (_id, context) => { entered(); await gate; context.checkActive(); sends++; });
  worker.start(); const work = worker.flush(); await started;
  now = 61000; release(); await work; await worker.stop();
  assert.equal(sends, 0);
});

test('delivery timeout and stop cancel pending work, with no effects after the gate opens', async t => {
  const state = fakeOutbox(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let sends = 0;
  const worker = new MessageOutboxWorker(async (_id, context) => { entered(); await gate; context.checkActive(); sends++; }, { deliveryTimeoutMs: 25, shutdownTimeoutMs: 25 });
  worker.start(); await worker.flush(); await worker.stop();
  await started; release(); await tick();
  assert.equal(sends, 0); assert.equal(state.completions, 0); assert.equal(state.retries, 1);
});

test('shutdown is bounded even if SQL claim never returns', async t => {
  patch(t, queries, { withTransaction: () => new Promise(() => {}) });
  const worker = new MessageOutboxWorker(async () => {}, { shutdownTimeoutMs: 20 });
  worker.start(); void worker.flush(); await worker.stop();
});

test('publisher refuses offline work rather than replaying cancelled messages later', async () => {
  assert.equal(fanoutPublisher.options.enableOfflineQueue, false);
  assert.equal(fanoutPublisher.options.maxRetriesPerRequest, 0);
  await assert.rejects(publishFanout('channel', { room: 'room', message: { id: 1, room_seq: 1 } }), /unavailable/);
});

test('Outbox notifications use the non-queuing publisher and recheck cancellation after session lookup', async t => {
  const { NotificationUser } = require('../../server/src/modules/realtime/notification');
  const { registerNotificationSocket, removeNotificationSocket } = require('../../server/src/modules/realtime/connections');
  const ws = socket('notification-probe', 'private');
  cleanRooms(t);
  let release, checking;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { checking = resolve; });
  registerSessionSocket(ws, 'recipient', 'token', async () => { checking(); await gate; return { id: 2 }; });
  registerNotificationSocket('recipient', ws, async () => {});
  t.after(() => removeNotificationSocket('recipient', ws));
  let publishes = 0;
  patch(t, better_chat, { publish: async () => { throw Error('Must not use offline-queuing shared client'); } });
  patch(t, fanoutPublisher, { status: 'ready', publish: async () => { publishes++; return 0; } });
  const controller = new AbortController();
  const work = NotificationUser({ receiver_username: 'recipient', name: 'chatList' }, () => controller.signal.throwIfAborted());
  const rejected = assert.rejects(work, /cancelled/);
  await entered; controller.abort(Error('cancelled')); release(); await rejected;
  assert.equal(publishes, 1); assert.equal(ws.frames.length, 0);
});

test('default and relative upload roots are independent of startup cwd', () => {
  const root = path.resolve(__dirname, '../..');
  const script = `require(${JSON.stringify(path.join(root, 'server/node_modules/ts-node/register/transpile-only'))}); console.log(require(${JSON.stringify(path.join(root, 'server/src/infrastructure/file-storage'))}).uploadRoot)`;
  for (const configured of ['', 'custom-uploads']) {
    const outputs = [root, path.join(root, 'server')].map(cwd => {
      const run = spawnSync(process.execPath, ['-e', script], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, UPLOAD_ROOT: configured } });
      assert.equal(run.status, 0, run.stderr); return run.stdout.trim();
    });
    assert.deepEqual(outputs, [path.join(root, 'server', configured || 'uploads'), path.join(root, 'server', configured || 'uploads')]);
  }
});
