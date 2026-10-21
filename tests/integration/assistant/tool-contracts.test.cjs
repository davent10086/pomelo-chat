const { serverRequire, serverRoot: testServerRoot, repoRoot: testRepoRoot } = require("../../helpers/paths.cjs");
const assert = require('node:assert/strict');
serverRequire('ts-node/register/transpile-only');
const { z } = serverRequire('zod');
const { AjvJsonSchemaValidator } = serverRequire('@modelcontextprotocol/server/validators/ajv');
const { better_chat } = require("../../../server/src/infrastructure/redis");
const social = require("../../../server/src/modules/social/permissions");
const repository = require("../../../server/src/modules/assistant/repository");
const { pomeloToolDefinitions, executePomeloTool, buildPomeloChatTools } = require("../../../server/src/modules/assistant/tools/pomelo-tools");
const { toolErrorResult } = require("../../../server/src/modules/assistant/tools/tool-runtime");
const { externalMcpManager: manager, externalToolName } = require("../../../server/src/modules/assistant/adapters/external-mcp");
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
	const messaging = require("../../../server/src/modules/messaging/search");
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
	const directory = require("../../../server/src/modules/social/directory");
	directory.searchVisibleContacts = async () => [{ user_id: 1, username: 'test', remark: null, room: 'room', name: null, signature: null, unexpected: 'private' }];
	assert.equal((await call('search_contacts', { query: 'test' })).contacts[0].unexpected, undefined);
	directory.searchJoinedGroups = async () => [{ id: 1, name: 'test', room: 'room', announcement: null }];
	assert.equal((await call('search_groups', { query: 'test' })).groups[0].id, 1);
	const { memorySaveSchema, memoryForgetSchema } = require("../../../server/src/modules/assistant/tools/memory-contracts");
	const { createPendingAction } = require("../../../server/src/modules/assistant/actions");
	for (const payload of [{ content: ' ' }, { content: 'password: example' }, { content: 'x'.repeat(1001) }, { content: 'ok', category: 'x'.repeat(33) }]) {
		assert.equal(memorySaveSchema.safeParse(payload).success, false);
		await assert.rejects(createPendingAction(userId, 'save_memory', payload), /Invalid memory proposal/);
		await assert.rejects(executePomeloTool({ userId, confirmationId: 'test' }, { name: 'save_memory', args: payload }), error => error.code === 'INVALID_ARGUMENTS');
	}
	assert.equal(memoryForgetSchema.safeParse({ id: 1.5 }).success, false);
	await assert.rejects(createPendingAction(userId, 'forget_memory', { id: 1.5 }), /Invalid memory deletion/);
	let memoryReads = 0;
	repository.searchOwnedMemories = async () => { memoryReads++; return [{ id: 1, category: 'preference', content: 'cached', created_at: '2026-01-01', updated_at: '2026-01-01' }]; };
	const cache = new Map();
	const cachedRead = (args, id = userId, memoryReads = cache) => executePomeloTool({ userId: id, memoryReads }, { name: 'search_memory', args });
	const [left, right] = await Promise.all([cachedRead({ query: ' same ' }), cachedRead({ query: 'same', limit: 8 })]);
	assert.equal(memoryReads, 1);
	left.memories[0].content = 'changed';
	assert.equal(right.memories[0].content, 'cached');
	await cachedRead({ query: 'other' });
	await cachedRead({ query: 'same', limit: 9 });
	await cachedRead({ query: 'same' }, userId + 1);
	await cachedRead({ query: 'same' }, userId, new Map());
	assert.equal(memoryReads, 5, 'different query, limit, user or request must not reuse a result');
	repository.searchOwnedMemories = async () => { memoryReads++; throw new Error('temporary'); };
	await assert.rejects(cachedRead({ query: 'retry' }));
	repository.searchOwnedMemories = async () => { memoryReads++; return []; };
	assert.deepEqual(await cachedRead({ query: 'retry' }), { memories: [] });
	assert.equal(memoryReads, 7, 'failed reads must not stay cached');
	const { consumeRateLimit } = require("../../../server/src/infrastructure/rate-counter");
	const rateKey = `shared-counter:${userId}`;
	const counts = await Promise.all(Array.from({ length: 10 }, () => consumeRateLimit(rateKey, 3, 60, 'reject')));
	assert.equal(counts.filter(Boolean).length, 3);
	assert.ok(await better_chat.ttl(rateKey) > 0);
	await better_chat.set(rateKey, '1');
	assert.equal(await consumeRateLimit(rateKey, 3, 60, 'reject'), true);
	assert.ok(await better_chat.ttl(rateKey) > 0, 'repair old counters without an expiry');
	const evalOriginal = better_chat.eval;
	const nowOriginal = Date.now;
	let now = nowOriginal();
	better_chat.eval = async () => { throw new Error('offline'); };
	Date.now = () => now;
	try {
		assert.equal(await consumeRateLimit('fallback-test', 1, 60, 'local'), true);
		assert.equal(await consumeRateLimit('fallback-test', 1, 60, 'local'), false);
		now += 60001;
		assert.equal(await consumeRateLimit('fallback-test', 1, 60, 'local'), true);
		await assert.rejects(consumeRateLimit('fallback-test', 1, 60, 'reject'), /offline/);
	} finally { better_chat.eval = evalOriginal; Date.now = nowOriginal; }
	await better_chat.del(rateKey, `ai_tool_rate:${userId + 1}`);
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
	const { callAgentTool } = require("../../../server/src/modules/assistant/agent-application");
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
