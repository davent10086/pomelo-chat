process.env.TS_NODE_PROJECT = require('node:path').join(process.cwd(), 'server/tsconfig.json');
require('../../server/node_modules/ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createRoomWriteQueue } = require('../../server/src/modules/messaging/contracts');
const { trackDelivery, acknowledgeDelivery, stopDeliveryObservation } = require('../../server/src/modules/realtime/delivery-observation');
const { renderMessageMetrics } = require('../../server/src/infrastructure/message-metrics');
const repository = require('../../server/src/modules/messaging/repository');
const { better_chat } = require('../../server/src/infrastructure/redis');
const { startMessagePressure, stopMessagePressure } = require('../../server/src/modules/messaging/pressure');
const { admitMessage } = require('../../server/src/modules/messaging/pressure');
const queryModule = require('../../server/src/infrastructure/database-query');
const { MessageOutboxWorker } = require('../../server/src/modules/messaging/outbox');

test('a write waking a nearly-finished empty outbox scan is delivered without the polling timer', async () => {
  const transaction = queryModule.withTransaction;
  const lock = repository.lockAvailableOutboxHead, claim = repository.claimOutboxRows;
  const complete = repository.completeOutboxClaim;
  let release, scanned, reads = 0;
  const captured = new Promise(resolve => { scanned = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const queued = [], delivered = [];
  queryModule.withTransaction = async fn => fn();
  repository.lockAvailableOutboxHead = async () => {
    if (++reads === 8) { scanned(); await gate; return []; }
    return queued.length ? [{ message_id: queued.shift() }] : [];
  };
  repository.claimOutboxRows = async () => ({ affectedRows: 1 });
  repository.completeOutboxClaim = async () => ({ affectedRows: 1 });
  const worker = new MessageOutboxWorker(async id => { delivered.push(id); });
  try {
    worker.start();
    const first = worker.flush();
    await captured;
    queued.push(99);
    const wake = worker.flush();
    release();
    await Promise.all([first, wake]);
    assert.deepEqual(delivered, [99]);
  } finally {
    release(); await worker.stop();
    queryModule.withTransaction = transaction;
    repository.lockAvailableOutboxHead = lock; repository.claimOutboxRows = claim;
    repository.completeOutboxClaim = complete;
  }
});

test('room/global admission is bounded, preserves order and releases capacity after errors', async () => {
  const enqueue = createRoomWriteQueue(() => ({ room: 2, global: 3 }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const order = [];
  const first = enqueue('a', async () => { await gate; order.push(1); throw Error('injected'); });
  const failed = assert.rejects(first, /injected/);
  const second = enqueue('a', async () => { order.push(2); });
  const third = enqueue('b', async () => { await gate; order.push(3); });
  assert.throws(() => enqueue('a', async () => {}), e => e.code === 'MESSAGE_OVERLOADED');
  assert.throws(() => enqueue('c', async () => {}), e => e.code === 'MESSAGE_OVERLOADED');
  release();
  await Promise.all([failed, second, third]);
  await new Promise(resolve => setImmediate(resolve));
  await enqueue('a', async () => order.push(4));
  assert.ok(order.indexOf(1) < order.indexOf(2));
  assert.equal(order.at(-1), 4);
});

test('receive measurements require the exact socket challenge and ignore duplicate receipts', () => {
  const socket = new EventEmitter(); socket.readyState = 1;
  const other = new EventEmitter(); other.readyState = 1;
  const count = () => Number(/pomelo_message_socket_receive_seconds_count (\d+)/.exec(renderMessageMetrics())?.[1] || 0);
  const before = count();
  const token = trackDelivery(socket, Date.now() - 2000);
  acknowledgeDelivery(other, token);
  assert.equal(count(), before);
  acknowledgeDelivery(socket, token);
  acknowledgeDelivery(socket, token);
  assert.equal(count(), before + 1);
  assert.match(renderMessageMetrics(), /pomelo_message_created_to_receive_seconds_count 1/);
  for (let i = 0; i < 128; i++) assert.ok(trackDelivery(socket));
  assert.equal(trackDelivery(socket), undefined);
  socket.emit('close');
  assert.match(renderMessageMetrics(), /pomelo_delivery_receipts_pending 0/);
  stopDeliveryObservation();
});

test('old room pressure isolates new-room writes and stale samples reject new work', async () => {
  const load = repository.loadOutboxPressure, evaluate = better_chat.eval, time = better_chat.time;
  repository.loadOutboxPressure = async () => [{ conversationId: 42, pending: 1, oldestSeconds: 30 }];
  better_chat.eval = async () => 0;
  better_chat.time = async () => ['100', '0'];
  const now = Date.now;
  try {
    await startMessagePressure();
    await assert.rejects(admitMessage(1, 'old', 'private', 42), e => e.reason === 'outbox_pressure');
    await admitMessage(1, 'healthy', 'private', 43);
    Date.now = () => now() + 10001;
    await assert.rejects(admitMessage(1, 'healthy', 'private', 43), e => e.reason === 'pressure_unavailable');
  } finally {
    Date.now = now;
    await stopMessagePressure();
    repository.loadOutboxPressure = load; better_chat.eval = evaluate; better_chat.time = time;
  }
});
