const { serverRequire, serverRoot: testServerRoot, repoRoot: testRepoRoot } = require("../../helpers/paths.cjs");
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.TS_NODE_PROJECT = path.join(testServerRoot, 'tsconfig.json');
require("../../../server/node_modules/ts-node/register/transpile-only");

const { classifyIntent, chooseAgents } = require("../../../server/src/modules/assistant/agent-orchestrator");
const { normalizeAgentRequest } = require("../../../server/src/modules/assistant/agent");
const { validateTaskCandidateSources } = require("../../../server/src/modules/assistant/agent-response");
const { normalizeUploadMetadata } = require("../../../server/src/shared/file");
const { hasMcpIdempotencyContract } = require("../../../server/src/modules/assistant/adapters/external-mcp");

const agents = (input, room) => chooseAgents(input, room).map(step => step.agent);

assert.equal(classifyIntent('你好'), 'chat');
assert.equal(classifyIntent('请总结这段聊天记录'), 'context');
assert.equal(classifyIntent('提取待办和负责人'), 'todo');
assert.equal(classifyIntent('帮我写一段回复'), 'reply');
assert.equal(classifyIntent('总结聊天并生成回复和待办'), 'mixed');

assert.deepEqual(agents('你好'), ['coordinator_agent']);
assert.ok(agents('你好', 'room-1').includes('chat_context_agent'));
assert.deepEqual(agents('总结聊天并生成回复和待办'), [
  'coordinator_agent',
  'chat_context_agent',
  'todo_agent',
  'reply_agent'
]);

assert.deepEqual(normalizeAgentRequest('room-1', {
  currentChatType: 'group',
  currentReceiverId: '42',
  recentMessagesText: 'context'
}), {
  room: 'room-1',
  context: { currentChatType: 'group', currentReceiverId: 42, recentMessagesText: 'context', memoryEnabled: true, readOnly: false }
});

assert.equal(normalizeAgentRequest('x'.repeat(129), {
  currentChatType: 'invalid',
  currentReceiverId: 'nope'
}).room, undefined);
assert.equal(normalizeAgentRequest('room-1', { memoryEnabled: false }).context.memoryEnabled, false);

const hash = 'a'.repeat(64);
assert.deepEqual(normalizeUploadMetadata(hash, '.png'), {
  fileHash: hash,
  ext: 'png',
  suffix: 'image'
});
assert.equal(normalizeUploadMetadata('../escape', 'png'), null);
assert.equal(normalizeUploadMetadata(hash, '../png'), null);
assert.equal(hasMcpIdempotencyContract('requestId', { properties: { requestId: { type: 'string' } }, required: ['requestId'] }), true);
assert.equal(hasMcpIdempotencyContract(undefined, { properties: { requestId: { type: 'string' } }, required: ['requestId'] }), false);
assert.equal(hasMcpIdempotencyContract('requestId', { properties: { requestId: { type: 'number' } }, required: ['requestId'] }), false);
assert.equal(hasMcpIdempotencyContract('requestId', { properties: { requestId: { type: 'string' } } }), false);
assert.deepEqual(validateTaskCandidateSources(
  [{ title: '完成测试', sourceMessageIds: [12, 999, 12, '12'] }],
  [{ id: 12, content: '明天完成测试', created_at: '2026-09-27' }]
)[0].sources.map(source => source.id), [12]);

console.log('[unit-agent-logic] all assertions passed');
process.exit(0);
