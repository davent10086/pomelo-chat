#!/usr/bin/env node
const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const { classifyIntent, chooseAgents } = require('../src/service/assistant/agent-orchestrator');
const { normalizeAgentRequest } = require('../src/service/assistant/agent');

const agentsOf = (input, room) => chooseAgents(input, room).map(step => step.agent);

assert.equal(classifyIntent('请总结这段聊天记录'), 'context');
assert.equal(classifyIntent('请提取待办和负责人'), 'todo');
assert.equal(classifyIntent('帮我写一段回复'), 'reply');
assert.equal(classifyIntent('总结聊天并生成回复和待办'), 'mixed');
assert.equal(classifyIntent('你好'), 'chat');

assert.deepEqual(agentsOf('请提取待办和负责人'), ['coordinator_agent', 'todo_agent']);
assert.deepEqual(agentsOf('帮我写一段回复'), ['coordinator_agent', 'reply_agent']);
assert.deepEqual(agentsOf('总结聊天并生成回复和待办'), [
	'coordinator_agent',
	'chat_context_agent',
	'todo_agent',
	'reply_agent'
]);
assert.deepEqual(agentsOf('你好'), ['coordinator_agent']);
assert.ok(agentsOf('你好', 'private-room').includes('chat_context_agent'));

const normalized = normalizeAgentRequest('room-1', {
	currentChatType: 'group',
	currentReceiverId: '42',
	recentMessagesText: 'context'
});
assert.deepEqual(normalized, {
	room: 'room-1',
	context: { currentChatType: 'group', currentReceiverId: 42, recentMessagesText: 'context' }
});
assert.deepEqual(normalizeAgentRequest('x'.repeat(129), { currentChatType: 'invalid', currentReceiverId: 'nope' }), {
	room: undefined,
	context: { currentChatType: undefined, currentReceiverId: undefined, recentMessagesText: undefined }
});

console.log('[agent-routing-test] all assertions passed');
process.exit(0);
