#!/usr/bin/env node
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
require('ts-node/register/transpile-only');

process.env.DEEPSEEK_API_KEY = 'test-key';

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'langchain') return {
		tool: () => ({}),
		createAgent: () => ({
			streamEvents: async () => ({
				messages: (async function* () {
					yield { text: (async function* () { yield '你好'; yield '，世界'; })() };
					yield { text: (async function* () { yield '最终答案'; })() };
				})(),
				toolCalls: (async function* () {
					yield { name: 'get_recent_messages', callId: 'call-1', status: Promise.resolve('finished'), output: Promise.resolve({ messages: [] }) };
				})(),
				output: Promise.resolve({ messages: [{ _getType: () => 'ai', content: '最终答案' }] })
			})
		})
	};
	if (request === '@langchain/openai') return {
		ChatOpenAI: class {
			withStructuredOutput() { return { invoke: async () => ({ todos: [], replySuggestions: [] }) }; }
		}
	};
	return originalLoad.call(this, request, parent, isMain);
};

const orchestrator = require('../src/modules/assistant/agent-orchestrator');
orchestrator.runAgentOrchestrator = async () => ({
	preToolTrace: [], observations: {}, intent: 'chat', agentTrace: ['coordinator_agent'], agentSteps: []
});
const external = require('../src/modules/assistant/adapters/external-mcp');
external.externalMcpManager.buildTools = async () => [];
const { better_chat } = require('../src/utils/authenticate');
better_chat.incr = async () => 1;
better_chat.expire = async () => 1;
const { agentStream } = require('../src/service/assistant/agent');

const response = new EventEmitter();
const chunks = [];
response.setHeader = () => response;
response.flushHeaders = () => {};
response.write = chunk => { chunks.push(chunk); return true; };
response.end = () => { response.writableEnded = true; };

agentStream({ user: { id: 1 }, body: { input: '打招呼', context: { memoryEnabled: false } } }, response)
	.then(() => {
		const output = chunks.join('');
		assert.match(output, /event: delta\ndata: \{"delta":"你好","reset":false\}/);
		assert.match(output, /event: delta\ndata: \{"delta":"，世界","reset":false\}/);
		assert.match(output, /event: delta\ndata: \{"delta":"最终答案","reset":true\}/);
		assert.match(output, /"type":"tool_started","agent":"main_agent","tool":"get_recent_messages"/);
		assert.match(output, /"type":"tool_completed","agent":"main_agent","tool":"get_recent_messages","status":"success"/);
		assert.ok(output.indexOf('event: delta') < output.indexOf('"content":"最终答案"'));
		assert.match(output, /data: \[DONE\]/);
		assert.equal(response.writableEnded, true);
		console.log('[agent-stream-test] all assertions passed');
		process.exit(0);
	})
	.catch(error => { console.error(error); process.exit(1); });
