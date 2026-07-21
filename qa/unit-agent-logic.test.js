#!/usr/bin/env node
const assert = require('node:assert/strict');
const path = require('node:path');

process.chdir(path.join(__dirname, '..', 'server'));
process.env.TS_NODE_PROJECT = path.join(process.cwd(), 'tsconfig.json');
require('../server/node_modules/dotenv').config({ path: path.join(process.cwd(), '.env') });
require('../server/node_modules/ts-node/register/transpile-only');

const { classifyIntent, chooseAgents } = require('../server/src/service/assistant/agent-orchestrator');
const { normalizeAgentRequest } = require('../server/src/service/assistant/agent');
const { normalizeUploadMetadata } = require('../server/src/utils/file');

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
  context: { currentChatType: 'group', currentReceiverId: 42, recentMessagesText: 'context', memoryEnabled: true }
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

console.log('[unit-agent-logic] all assertions passed');
process.exit(0);
