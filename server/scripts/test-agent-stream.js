#!/usr/bin/env node
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
require('ts-node/register/transpile-only');

process.env.DEEPSEEK_API_KEY = 'test-key';
const modelConfigs = [];
let externalToolLoads = 0;
let actionProposals = 0;
let memoryReads = 0;
const memoryQueries = [];
const modelOptions = [];
let textOnly = false;
let metadataExtractions = 0;
const suggested = { content: '文本总结', todos: [{ title: '不要保存这个待办' }], replySuggestions: ['建议回复'], memorySuggestion: { content: '不要保存这个记忆' } };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'langchain') return {
		tool: () => ({}),
		createAgent: config => { modelConfigs.push(config); return ({
			invoke: async () => ({ structuredResponse: suggested }),
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
		}); }
	};
	if (request === '@langchain/openai') return {
		ChatOpenAI: class {
			constructor(options) { modelOptions.push(options); }
			withStructuredOutput() { metadataExtractions++; return { invoke: async () => textOnly ? suggested : ({ todos: [], replySuggestions: [] }) }; }
		}
	};
	return originalLoad.call(this, request, parent, isMain);
};

const orchestrator = require('../src/modules/assistant/agent-orchestrator');
orchestrator.runAgentOrchestrator = async () => ({
	preToolTrace: [], observations: {}, intent: 'chat', agentTrace: ['coordinator_agent'], agentSteps: []
});
const external = require('../src/modules/assistant/adapters/external-mcp');
external.externalMcpManager.buildTools = async () => { externalToolLoads++; return []; };
const actions = require('../src/modules/assistant/actions');
actions.createPendingAction = async () => { actionProposals++; throw new Error('unexpected proposal'); };
const tools = require('../src/modules/assistant/tools/pomelo-tools');
tools.executePomeloTool = async (_context, call) => { memoryReads++; memoryQueries.push(call.args.query); return { memories: [] }; };
const { better_chat } = require('../src/infrastructure/redis');
better_chat.eval = async () => 1;
const { agentStream } = require('../src/modules/assistant/agent-http');

const response = new EventEmitter();
const chunks = [];
response.setHeader = () => response;
response.flushHeaders = () => {};
response.write = chunk => { chunks.push(chunk); return true; };
response.end = () => { response.writableEnded = true; };

agentStream({ user: { id: 1 }, body: { input: '打招呼', context: { memoryEnabled: false } } }, response)
	.then(async () => {
		const output = chunks.join('');
		assert.match(output, /event: delta\ndata: \{"delta":"你好","reset":false\}/);
		assert.match(output, /event: delta\ndata: \{"delta":"，世界","reset":false\}/);
		assert.match(output, /event: delta\ndata: \{"delta":"最终答案","reset":true\}/);
		assert.match(output, /"type":"tool_started","agent":"main_agent","tool":"get_recent_messages"/);
		assert.match(output, /"type":"tool_completed","agent":"main_agent","tool":"get_recent_messages","status":"success"/);
		assert.ok(output.indexOf('event: delta') < output.indexOf('"content":"最终答案"'));
		assert.match(output, /data: \[DONE\]/);
		assert.equal(response.writableEnded, true);
		assert.equal(metadataExtractions, 1, 'normal streaming chat retains metadata extraction');
		textOnly = true;
		const { agentChat } = require('../src/modules/assistant/agent-application');
		const result = await agentChat({ id: 1 }, { input: '总结', context: { readOnly: true } });
		assert.equal(result.data.content, '文本总结');
		assert.deepEqual(result.data.replySuggestions, ['建议回复']);
		assert.deepEqual(result.data.actions, []);
		const readonlyResponse = new EventEmitter();
		const readonlyChunks = [];
		readonlyResponse.setHeader = () => {};
		readonlyResponse.flushHeaders = () => {};
		readonlyResponse.write = chunk => readonlyChunks.push(chunk);
		readonlyResponse.end = () => { readonlyResponse.writableEnded = true; };
		await agentStream({ user: { id: 1 }, body: { input: '总结', context: { readOnly: true } } }, readonlyResponse);
		assert.match(readonlyChunks.join(''), /"actions":\[\]/);
		assert.match(readonlyChunks.join(''), /data: \[DONE\]/);
		assert.deepEqual(modelConfigs.slice(1).map(config => config.tools), [[], []]);
		assert.equal(externalToolLoads, 1);
		assert.equal(actionProposals, 0);
		assert.equal(memoryReads, 0);
		assert.equal(metadataExtractions, 1, 'read-only streaming makes no extra metadata request');
		assert.equal(modelOptions[0].temperature, 0.3);
        assert.equal(modelOptions[0].maxRetries, 1);
        const { createAssistantModel } = require('../src/modules/assistant/model');
        createAssistantModel({ temperature: 0 });
        assert.equal(modelOptions.at(-1).temperature, 0);
        assert.equal(modelOptions.at(-1).maxRetries, undefined);
        assert.equal(modelOptions.at(-1).timeout, modelOptions[0].timeout);
        assert.deepEqual(modelOptions.at(-1).configuration, modelOptions[0].configuration);
        suggested.todos = []; delete suggested.memorySuggestion;
        const longReply = await agentChat({ id: 1 }, { input: 'x'.repeat(1000), context: { memoryEnabled: true } });
        assert.equal(longReply.code, 200);
        assert.equal(memoryQueries.at(-1).length, 120, 'preload must respect the memory query contract');
        console.log('[agent-stream-test] all assertions passed');
		process.exit(0);
	})
	.catch(error => { console.error(error); process.exit(1); });
