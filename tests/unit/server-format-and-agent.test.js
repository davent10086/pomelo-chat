process.env.TS_NODE_PROJECT = require('node:path').join(process.cwd(), 'server', 'tsconfig.json');
require('../../server/node_modules/ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const test = require('node:test');
const { after, before } = require('node:test');
const { formatBytes } = require('../../server/src/utils/format');
const { classifyIntent, chooseAgents } = require('../../server/src/service/assistant/agent-orchestrator');
const { createTestTempDirectory, cleanupTestArtifacts } = require('../helpers/test-lifecycle');

before(createTestTempDirectory);
after(cleanupTestArtifacts);

test('formatBytes formats valid values and safely rejects invalid byte counts', () => {
	assert.equal(formatBytes(0), '0B');
	assert.equal(formatBytes(1024), '1K');
	assert.equal(formatBytes(1536), '1.5K');
	assert.equal(formatBytes(-1), '0B');
	assert.equal(formatBytes(Number.NaN), '0B');
	assert.equal(formatBytes(Number.POSITIVE_INFINITY), '0B');
});

test('agent routing recognizes Chinese mixed intent and preserves bounded specialist selection', () => {
	assert.equal(classifyIntent('请总结聊天并生成回复和待办'), 'mixed');
	assert.deepEqual(
		chooseAgents('请总结聊天并生成回复和待办').map(step => step.agent),
		['coordinator_agent', 'chat_context_agent', 'todo_agent', 'reply_agent']
	);
	assert.deepEqual(chooseAgents('你好').map(step => step.agent), ['coordinator_agent']);
});
