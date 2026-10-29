// @tags assistant regression security
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { serverRequire } = require('../../helpers/paths.cjs');
serverRequire('ts-node/register/transpile-only');
const { normalizeReviewInput, validateReview, runConversationReview } = require('../../../server/src/modules/assistant/conversation-review');
const { better_chat } = require('../../../server/src/infrastructure/redis');
after(() => better_chat.disconnect());
const scope = () => normalizeReviewInput({ room: 'room-a', range: { preset: 'today' } }, new Date('2026-10-24T08:00:00Z'));
const row = (id, content = `消息 ${id}`, media_type = 'text') => ({
  id, content, media_type, sender_id: 1, sender_name: '甲', created_at: '2026-10-24T01:00:00Z'
});
const empty = () => ({ topics: [], decisions: [], questions: [], actions: [], answer: [] });
const deps = (rows, generate = async () => empty()) => {
  const calls = [];
  return { calls, roomType: async () => 'private', generate,
    search: async (userId, room, type, options) => {
      calls.push({ userId, room, type, options });
      const selected = rows.filter(item => !options.beforeId || item.id < options.beforeId).sort((a, b) => b.id - a.id);
      return { messages: selected.slice(0, options.limit), hasMore: selected.length > options.limit };
    }
  };
};

test('review ranges use Shanghai dates and reject malformed or unbounded requests', () => {
  const now = new Date('2026-12-31T16:01:00Z');
  assert.deepEqual(normalizeReviewInput({ room: 'a', range: { preset: 'today' } }, now).range,
    { since: '2027-01-01', until: '2027-01-01' });
  assert.deepEqual(normalizeReviewInput({ room: 'a', range: { preset: 'week' } }, now).range,
    { since: '2026-12-26', until: '2027-01-01' });
  for (const range of [
    { preset: 'custom', since: '2026-02-30', until: '2026-03-01' },
    { preset: 'custom', since: '2026-10-25', until: '2026-10-24' },
    { preset: 'custom', since: '2026-01-01', until: '2026-02-01' },
    { preset: 'custom' }, { preset: 'all' }
  ]) assert.throws(() => normalizeReviewInput({ room: 'a', range }), error => error.code === 'INVALID_INPUT');
  for (const extra of [{ beforeId: '123' }, { beforeId: -1 }, { beforeId: Number.MAX_SAFE_INTEGER + 1 }, { question: 'x'.repeat(1501) }, { room: ['a'] }])
    assert.throws(() => normalizeReviewInput({ room: 'a', range: { preset: 'today' }, ...extra }));
});

test('review paginates beyond recent messages, preserves order, and discloses the 200-message boundary', async () => {
  let received;
  const dependency = deps(Array.from({ length: 205 }, (_, i) => row(i + 1)), async messages => {
    received = messages;
    return { ...empty(), decisions: [{ text: '决定', sourceMessageIds: [205] }] };
  });
  const result = await runConversationReview(7, scope(), undefined, dependency);
  assert.equal(dependency.calls.length, 4);
  assert.deepEqual(dependency.calls.map(call => call.options.beforeId), [undefined, 156, 106, 56]);
  assert.ok(dependency.calls.every(call => call.userId === 7 && call.room === 'room-a' && call.options.since === '2026-10-24'));
  assert.equal(received.length, 200);
  assert.equal(received[0].id, 6);
  assert.equal(received.at(-1).id, 205);
  assert.equal(result.coverage.hasEarlier, true);
  assert.equal(result.coverage.nextBeforeId, 6);
  assert.equal(result.coverage.newestId, 205);
  assert.equal(result.decisions[0].sources[0].id, 205);
  const earlier = await runConversationReview(7, { ...scope(), beforeId: 6 }, undefined, dependency);
  assert.equal(earlier.coverage.scannedMessages, 5);
  assert.equal(earlier.coverage.hasEarlier, false);
});

test('character limits preserve a continuation cursor and flag clipped text and skipped attachments', async () => {
  const dependency = deps([row(20, 'file.png', 'image'), ...Array.from({ length: 19 }, (_, i) => row(19 - i, '长'.repeat(4000)))]);
  const result = await runConversationReview(1, scope(), undefined, dependency);
  assert.equal(result.coverage.scannedMessages, 17);
  assert.equal(result.coverage.analyzedMessages, 16);
  assert.equal(result.coverage.skippedMedia, 1);
  assert.equal(result.coverage.contentTruncated, true);
  assert.equal(result.coverage.hasEarlier, true);
  assert.equal(result.coverage.nextBeforeId, 4);
  const earlier = await runConversationReview(1, { ...scope(), beforeId: 4 }, undefined, dependency);
  assert.equal(earlier.coverage.analyzedMessages, 3);
  assert.equal(earlier.coverage.hasEarlier, false);
});

test('invalid citations hide the entire claim, deduplicate valid sources, and never copy model source text', () => {
  const result = validateReview({ ...empty(), decisions: [
    { text: 'valid', sourceMessageIds: [1, 1] },
    { text: 'foreign', sourceMessageIds: [99] },
    { text: 'mixed unsupported claim', sourceMessageIds: [1, 99] }
  ] }, [{ id: 1, sender: '真实作者', text: '真实消息', createdAt: '2026-10-24' }]);
  assert.equal(result.omittedItems, 2);
  assert.equal(result.decisions.length, 1);
  assert.deepEqual(result.decisions[0].sources, [{ id: 1, sender: '真实作者', content: '真实消息', createdAt: '2026-10-24' }]);
  assert.throws(() => validateReview({ ...empty(), topics: [{ text: 'no evidence', sourceMessageIds: [] }] }, []));
});

test('room denial, revocation, and cancellation cannot return model results', async () => {
  const denied = deps([row(1)]);
  denied.roomType = async () => undefined;
  await assert.rejects(runConversationReview(1, scope(), undefined, denied), error => error.code === 'TARGET_UNAVAILABLE');
  assert.equal(denied.calls.length, 0);
  let checks = 0;
  const revoked = deps([row(1)]);
  revoked.roomType = async () => ++checks === 1 ? 'private' : undefined;
  await assert.rejects(runConversationReview(1, scope(), undefined, revoked), error => error.code === 'TARGET_UNAVAILABLE');
  const controller = new AbortController();
  const cancelled = deps([row(1)], async () => { controller.abort(); return empty(); });
  await assert.rejects(runConversationReview(1, scope(), controller.signal, cancelled), error => error.name === 'AbortError');
});

test('empty or attachment-only scopes do not invoke a model; snapshot questions exclude new messages', async () => {
  let generations = 0;
  const dependency = deps([row(3, 'photo', 'image')], async () => { generations++; return empty(); });
  const result = await runConversationReview(1, scope(), undefined, dependency);
  assert.equal(generations, 0);
  assert.equal(result.coverage.analyzedMessages, 0);
  assert.equal(result.coverage.skippedMedia, 1);
  const question = deps([row(3), row(2), row(1)], async (messages, input) => {
    assert.deepEqual(messages.map(item => item.id), [1, 2]);
    assert.equal(input.question, '最终决定？');
    return { ...empty(), answer: [{ text: '决定', sourceMessageIds: [2] }] };
  });
  const answer = await runConversationReview(1, { ...scope(), beforeId: 3, question: '最终决定？' }, undefined, question);
  assert.equal(answer.answer[0].sources[0].id, 2);
});
