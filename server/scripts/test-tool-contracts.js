#!/usr/bin/env node
const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');
const { z } = require('zod');
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/server/validators/ajv');
const { better_chat } = require('../src/infrastructure/redis');
const social = require('../src/modules/social/permissions');
const repository = require('../src/modules/assistant/repository');
const { pomeloToolDefinitions, executePomeloTool, buildPomeloChatTools } = require('../src/modules/assistant/tools/pomelo-tools');
const { toolErrorResult } = require('../src/modules/assistant/tools/tool-runtime');
const { externalMcpManager: manager, externalToolName } = require('../src/modules/assistant/adapters/external-mcp');
const validator = new AjvJsonSchemaValidator();
const userId = 700000 + Math.floor(Math.random() * 100000);
const call = (name, args, id = userId) => executePomeloTool({ userId: id, currentRoom: 'missing' }, { name, args });
const configure = (name, names) => {
	process.env.MCP_SERVERS_JSON = JSON.stringify([{ name, url: 'https://example.invalid/mcp', allowedUserIds: [userId], readTools: names }]);
};

(async () => {
	for (const built of buildPomeloChatTools({ userId })) {
		const definition = pomeloToolDefinitions.find(item => item.name === built.name);
		assert.deepEqual(z.toJSONSchema(built.schema, { io: 'input' }), definition.inputSchema);
	}
	const invalidCases = [
		['search_messages', { query: '' }], ['search_messages', { query: 'x', since: '2026-02-30' }], ['search_messages', { query: 'x', beforeId: -1 }],
		['get_recent_messages', { limit: 81 }], ['get_recent_messages', { limit: 1.5 }],
		['suggest_replies', { text: 'x', count: 1.5 }], ['search_memory', { limit: 0 }],
		['search_contacts', { query: 'x'.repeat(121) }], ['extract_todos', { text: 'x'.repeat(20001) }]
	];
	for (const [name, args] of invalidCases) {
		const definition = pomeloToolDefinitions.find(item => item.name === name);
		assert.equal(validator.getValidator(definition.inputSchema)(args).valid, false);
		await assert.rejects(call(name, args), error => error.code === 'INVALID_ARGUMENTS');
	}
	await assert.rejects(call('save_memory', { content: 'hello' }), error => error.code === 'CONFIRMATION_REQUIRED');
	social.accessibleRoomType = async () => null;
	await assert.rejects(call('search_messages', { query: 'hello' }), error => error.code === 'TARGET_UNAVAILABLE');
	const messaging = require('../src/modules/messaging/search');
	social.accessibleRoomType = async () => 'private';
	messaging.searchRoomMessages = async () => ({ messages: [], hasMore: false });
	assert.deepEqual(await call('search_messages', { query: 'no matches' }), { matches: [], hasMore: false });
	social.accessibleRoomType = async () => null;
	const builtSearch = buildPomeloChatTools({ userId }).find(item => item.name === 'search_messages');
	assert.equal(JSON.parse(await builtSearch.invoke({ query: 'hello' })).error.code, 'TARGET_UNAVAILABLE');
	repository.searchOwnedMemories = async () => { throw new Error('SQL password=private'); };
	try { await call('search_memory', {}); assert.fail('expected error'); }
	catch (error) { assert.equal(error.code, 'EXECUTION_FAILED'); assert.doesNotMatch(JSON.stringify(toolErrorResult(error)), /password|SQL/); }
	repository.searchOwnedMemories = async () => [{ wrong: 'output' }];
	await assert.rejects(call('search_memory', {}), error => error.code === 'EXECUTION_FAILED');
	repository.searchOwnedMemories = async () => [{ id: 1, category: 'preference', content: 'hello', created_at: new Date('2026-01-01Z'), updated_at: new Date('2026-01-01Z') }];
	assert.equal((await call('search_memory', {})).memories[0].created_at, '2026-01-01T00:00:00.000Z');
	const directory = require('../src/modules/social/directory');
	directory.searchVisibleContacts = async () => [{ user_id: 1, username: 'test', remark: null, room: 'room', name: null, signature: null, unexpected: 'private' }];
	assert.equal((await call('search_contacts', { query: 'test' })).contacts[0].unexpected, undefined);
	directory.searchJoinedGroups = async () => [{ id: 1, name: 'test', room: 'room', announcement: null }];
	assert.equal((await call('search_groups', { query: 'test' })).groups[0].id, 1);
	let requests = [];
	const remoteSchema = { type: 'object', properties: { query: { type: 'string', enum: ['ok'] }, options: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] } }, required: ['query', 'options'] };
	let invoked = [];
	manager.connect = async config => ({ config, client: {
		listTools: async params => { requests.push(params); return params?.cursor === 'page2' ? { tools: [{ name: 'foo_bar', inputSchema: remoteSchema }] } : { tools: [{ name: 'foo.bar', inputSchema: remoteSchema }], nextCursor: 'page2' }; },
		callTool: async params => { invoked.push(params); return { content: [{ type: 'text', text: params.name }] }; }, close: async () => {}
	} });
	configure('pages', ['foo.bar', 'foo_bar']);
	const remote = await manager.getTools(userId);
	assert.equal(remote.length, 2);
	assert.deepEqual(requests, [undefined, { cursor: 'page2' }]);
	assert.notEqual(remote[0].definition.name, remote[1].definition.name);
	assert.notEqual(externalToolName('a_b', 'c'), externalToolName('a', 'b_c'));
	assert.notEqual(externalToolName('a', 'x'.repeat(80) + 'a'), externalToolName('a', 'x'.repeat(80) + 'b'));
	assert.ok(externalToolName('x'.repeat(100), 'y'.repeat(100)).length <= 64);
	const builtRemote = await manager.buildTools(userId);
	assert.deepEqual(builtRemote[0].schema, remoteSchema);
	await assert.rejects(remote[0].invoke({ query: 'ok' }), error => error.code === 'INVALID_ARGUMENTS');
	assert.equal(invoked.length, 0);
	for (const item of remote) await item.invoke({ query: 'ok', options: { count: 1 } });
	assert.deepEqual(invoked.map(item => item.name), ['foo.bar', 'foo_bar']);
	manager.connect = async config => ({ config, client: { listTools: async () => ({ tools: [], nextCursor: 'loop' }), close: async () => {} } });
	configure('cycle', ['foo']);
	assert.deepEqual(await manager.getTools(userId), []);
	const rateUser = userId + 1000000;
	const results = await Promise.allSettled(Array.from({ length: 121 }, () => call('suggest_replies', { text: 'hello' }, rateUser)));
	assert.equal(results.filter(item => item.status === 'fulfilled').length, 120);
	assert.equal(results.find(item => item.status === 'rejected').reason.code, 'RATE_LIMITED');
	const rateBuilt = buildPomeloChatTools({ userId: rateUser }).find(item => item.name === 'suggest_replies');
	assert.equal(JSON.parse(await rateBuilt.invoke({ text: 'hello' })).error.code, 'RATE_LIMITED');
	const { callAgentTool } = require('../src/modules/assistant/agent-application');
	const http = await callAgentTool({ id: rateUser }, { name: 'suggest_replies', args: { text: 'hello' } });
	assert.equal(http.code, 8001);
	assert.equal(http.data.error.code, 'RATE_LIMITED');
	assert.ok(await better_chat.ttl(`ai_tool_rate:${rateUser}`) > 0);
	const originalEval = better_chat.eval;
	better_chat.eval = async () => { throw new Error('offline'); };
	try { await assert.rejects(call('suggest_replies', { text: 'hello' }), error => error.code === 'EXECUTION_FAILED'); }
	finally { better_chat.eval = originalEval; }
	await manager.close();
	await better_chat.del(`ai_tool_rate:${userId}`, `ai_tool_rate:${rateUser}`);
	await better_chat.quit();
	console.log('[tool-contracts-test] all assertions passed');
})().catch(error => { console.error(error); process.exit(1); });
