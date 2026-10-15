#!/usr/bin/env node
const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const { externalMcpManager, isMcpToolAllowed, hasMcpIdempotencyContract, externalToolName } = require('../src/modules/assistant/adapters/external-mcp');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { executePomeloTool, buildPomeloChatTools } = require('../src/modules/assistant/tools/pomelo-tools');

assert.equal(isMcpToolAllowed({}, 1, 'delete_all'), false);
assert.equal(isMcpToolAllowed({ allowedUserIds: [1] }, 1, 'delete_all'), false);
assert.equal(isMcpToolAllowed({ allowedUserIds: [1], readTools: ['list'] }, 2, 'list'), false);
assert.equal(isMcpToolAllowed({ allowedUserIds: [1, 2], readTools: ['list'] }, 1, 'list'), false);
assert.equal(isMcpToolAllowed({ allowedUserIds: [1], readTools: ['list'] }, 1, 'list'), true);
assert.equal(hasMcpIdempotencyContract('requestId', { properties: { requestId: { type: 'string' } }, required: ['requestId'] }), true);

const tools = [
	{ name: 'list', inputSchema: { type: 'object' } },
	{ name: 'delete_all', inputSchema: { type: 'object' } },
	{ name: 'create', inputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] } }
];
externalMcpManager.connect = async config => ({
	config,
	client: { listTools: async () => ({ tools }), close: async () => undefined, callTool: async () => ({ content: [] }) }
});

const configure = (name, extra) => {
	process.env.MCP_SERVERS_JSON = JSON.stringify([{ name, url: 'https://example.com/mcp', allowedUserIds: [1], ...extra }]);
};

(async () => {
	await assert.rejects(executePomeloTool({ userId: 1 }, { name: 'save_memory', args: { content: 'blocked' } }), /confirmed action/);
	assert.equal(buildPomeloChatTools({ userId: 1 }).some(item => item.name === 'save_memory' || item.name === 'forget_memory'), false);
	configure('unclassified', {});
	assert.deepEqual(await externalMcpManager.getTools(1), []);
	configure('read_only', { readTools: ['list'] });
	assert.deepEqual((await externalMcpManager.getTools(1)).map(item => item.definition.name), [externalToolName('read_only', 'list')]);
	assert.deepEqual(await externalMcpManager.getTools(2), []);
	assert.deepEqual((await externalMcpManager.buildTools(1)).map(item => item.name), [externalToolName('read_only', 'list')]);
	configure('mixed', { readTools: ['list'], writeTools: ['create'], idempotencyKeys: { create: 'requestId' } });
	assert.deepEqual((await externalMcpManager.getTools(1)).map(item => item.definition.name), [externalToolName('mixed', 'list'), externalToolName('mixed', 'create')]);
	assert.deepEqual((await externalMcpManager.buildTools(1)).map(item => item.name), [externalToolName('mixed', 'list')]);
	assert.equal(await externalMcpManager.isWriteTool(externalToolName('mixed', 'create'), 1), true);
	assert.equal(await externalMcpManager.isWriteTool(externalToolName('mixed', 'create'), 2), false);
	configure('shared', { allowedUserIds: [1, 2], readTools: ['list'] });
	assert.deepEqual(await externalMcpManager.getTools(1), []);

	delete externalMcpManager.connect;
	const originalConnect = Client.prototype.connect;
	const originalListTools = Client.prototype.listTools;
	const originalClose = Client.prototype.close;
	let connectionAttempts = 0;
	Client.prototype.connect = async () => {
		connectionAttempts += 1;
		if (connectionAttempts === 1) throw new Error('temporary connection failure');
	};
	Client.prototype.listTools = async () => ({ tools });
	Client.prototype.close = async () => undefined;
	try {
		configure('transient', { readTools: ['list'] });
		assert.deepEqual(await externalMcpManager.getTools(1), []);
		assert.deepEqual((await externalMcpManager.getTools(1)).map(item => item.definition.name), [externalToolName('transient', 'list')]);
		assert.equal(connectionAttempts, 2);
		let closes = 0;
		Client.prototype.connect = () => new Promise(() => undefined);
		Client.prototype.close = async () => { closes += 1; };
		configure('hung', { readTools: ['list'] });
		assert.deepEqual(await externalMcpManager.getTools(1), []);
		assert.equal(closes, 1);
	} finally {
		Client.prototype.connect = originalConnect;
		Client.prototype.listTools = originalListTools;
		Client.prototype.close = originalClose;
	}
	console.log('[mcp-policy-test] all assertions passed');
})().catch(error => { console.error('[mcp-policy-test] failed:', error); process.exitCode = 1; });
