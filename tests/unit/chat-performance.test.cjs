const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { serverRequire, repoRoot } = require('../helpers/paths.cjs');
const ts = serverRequire('typescript');
const load = file => {
  const output = ts.transpileModule(fs.readFileSync(path.join(repoRoot, 'client/src/utils', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', output)(module.exports, module);
  return module.exports;
};
const { mergeMessages } = load('message-merge.ts');
const { CoalescedRefresh } = load('coalesced-refresh.ts');
const { buildHeightOffsets, findHeightIndex } = load('virtual-layout.ts');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('message ACKs preserve sent status, sender-scoped identity and sequence order', () => {
  const pending = { sender_id: 1, clientMsgId: 'same', content: 'draft', status: 'pending' };
  const peer = { sender_id: 2, client_msg_id: 'same', id: 2, room_seq: 2, status: 'sent' };
  const sent = { ...pending, id: 1, room_seq: 1, status: 'sent' };
  const initial = [pending, peer];
  const result = mergeMessages(initial, [sent, { ...sent, status: 'failed', failureReason: 'late timeout' }]);
  assert.equal(initial[0], pending);
  assert.deepEqual(result.map(row => row.id), [1, 2]);
  assert.equal(result[0].status, 'sent');
  assert.equal(result[0].failureReason, undefined);
  assert.equal(result[1], peer);
});

test('indexed merge matches first-match behavior for duplicate and changing identities', () => {
  const reference = (previous, incoming) => {
    const result = [...previous];
    for (const item of incoming) {
      const clientId = item.client_msg_id || item.clientMsgId;
      const index = result.findIndex(old => (item.id !== undefined && item.id !== null && old.id === item.id) ||
        (clientId && String(old.sender_id) === String(item.sender_id) && (old.client_msg_id || old.clientMsgId) === clientId));
      if (index < 0) result.push(item);
      else {
        const old = result[index];
        const merged = { ...old, ...item, clientMsgId: clientId || old.clientMsgId };
        if (old.status === 'sent' || item.status === 'sent') { merged.status = 'sent'; merged.failureReason = undefined; }
        result[index] = merged;
      }
    }
    return result.sort((a, b) => a.room_seq && b.room_seq ? a.room_seq - b.room_seq : a.room_seq ? -1 : b.room_seq ? 1 : 0);
  };
  let seed = 1234567;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let run = 0; run < 100; run++) {
    const rows = Array.from({ length: 100 }, () => ({
      id: random(3) ? random(30) : undefined, sender_id: random(3), client_msg_id: random(3) ? String(random(30)) : undefined,
      room_seq: random(30), status: random(2) ? 'sent' : 'pending'
    }));
    assert.deepEqual(mergeMessages(rows.slice(0, 40), rows.slice(40)), reference(rows.slice(0, 40), rows.slice(40)));
  }
});

test('large message batches retain every ID and collapse replayed history', () => {
  const rows = Array.from({ length: 20000 }, (_, index) => ({ id: index + 1, room_seq: index + 1, sender_id: 1 }));
  const merged = mergeMessages([], rows);
  assert.equal(merged.length, rows.length);
  assert.deepEqual(mergeMessages(merged, rows).map(row => row.id), rows.map(row => row.id));
});

test('virtual offsets support variable heights, exact edges and logarithmic lookup', () => {
  const heights = Array.from({ length: 20000 }, (_, index) => 20 + index % 100);
  const offsets = buildHeightOffsets(heights.length, index => heights[index]);
  for (const offset of [0, 1, 20, 21, offsets[100], offsets[100] + 1, offsets.at(-1), offsets.at(-1) + 100]) {
    let expected = heights.length - 1;
    for (let index = 0; index < heights.length; index++) if (offsets[index + 1] >= offset) { expected = index; break; }
    let reads = 0;
    const tracked = new Proxy(offsets, { get(target, key) { if (/^\d+$/.test(String(key))) reads++; return target[key]; } });
    assert.equal(findHeightIndex(tracked, offset), expected);
    assert.ok(reads < 20, `lookup used ${reads} reads`);
  }
  assert.equal(findHeightIndex([0], 100), 0);
});

test('refresh bursts coalesce and invalidations during a request produce a trailing refresh', { timeout: 2000 }, async t => {
  const entered = deferred(), release = deferred(), finished = deferred();
  const results = []; let calls = 0;
  const refresh = new CoalescedRefresh(async () => {
    calls++;
    if (calls === 1) { entered.resolve(); await release.promise; }
    return calls;
  }, value => { results.push(value); if (value === 2) finished.resolve(); }, () => assert.fail('unexpected error'), 5);
  t.after(() => refresh.cancel());
  for (let index = 0; index < 100; index++) refresh.invalidate();
  await entered.promise;
  const shared = refresh.refresh();
  assert.equal(shared, refresh.refresh());
  for (let index = 0; index < 100; index++) refresh.invalidate();
  assert.equal(calls, 1);
  release.resolve();
  await finished.promise;
  await wait(20);
  assert.equal(calls, 2);
  assert.deepEqual(results, [1, 2]);
});

test('refresh cancellation suppresses stale results and allows remount/retry after failure', async () => {
  const release = deferred(); const results = []; let errors = 0, calls = 0;
  const refresh = new CoalescedRefresh(async () => {
    if (++calls === 1) { await release.promise; return 'old account'; }
    if (calls === 2) throw new Error('temporary outage');
    return 'new account';
  }, value => results.push(value), () => errors++, 5);
  const old = refresh.refresh();
  await Promise.resolve();
  refresh.invalidate(); refresh.cancel();
  await refresh.refresh();
  assert.equal(errors, 1);
  release.resolve(); await old;
  await refresh.refresh(); await wait(15);
  assert.deepEqual(results, ['new account']);
  assert.equal(calls, 3);
  refresh.cancel();
});
