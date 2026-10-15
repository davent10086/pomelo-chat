#!/usr/bin/env node
const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const queryModule = require('../src/infrastructure/database-query');
const calls = [];
const messages = [
	{ id: 10, room: 'room-a', sender_id: 1, content: '进度 100%', media_type: 'text', created_at: '2026-10-01', sender_name: '甲' },
	{ id: 11, room: 'room-a', sender_id: 2, content: '看到 100% 报告', media_type: 'text', created_at: '2026-10-02', sender_name: '乙' },
	{ id: 12, room: 'room-a', sender_id: 1, content: '下一步继续', media_type: 'text', created_at: '2026-10-03', sender_name: '甲' }
];
queryModule.Query = async (sql, values = []) => {
	const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
	calls.push({ sql: normalized, values });
	if (normalized.includes('from friend as f') && normalized.includes('inner join friend_group')) {
		return values[0] === 1 && values[1] === 'room-a' ? [{ ok: 1 }] : [];
	}
	if (normalized.includes('from group_chat as gc') && normalized.includes('inner join group_members')) return [];
	if (normalized.includes('from message as m') && normalized.includes('where m.id = ? limit 1')) {
		return messages.filter(item => item.id === values[0]);
	}
	if (normalized.includes('from message as m') && normalized.includes('m.content like')) {
		assert.match(normalized, /m\.room = \?/);
		return messages.filter(item => item.room === values[0] && item.content.includes('100%') && (!values.includes(11) || item.id < 11))
			.reverse().slice(0, values.at(-1));
	}
	if (normalized.includes('from message as m') && normalized.includes('where m.room = ? and m.type = ? and m.id = ?')) return messages.filter(item => item.room === values[0] && item.id === values[2]);
	if (normalized.includes('from message as m') && normalized.includes('where m.room = ? and m.type = ? and m.id')) {
		const before = normalized.includes('m.id < ?');
		return messages.filter(item => item.room === values[0] && (before ? item.id < values[2] : item.id > values[2]))
			.sort((a, b) => before ? b.id - a.id : a.id - b.id).slice(0, values[3]);
	}
	if (normalized.includes('from assistant_task')) {
		assert.equal(values[0], 1);
		return [{ id: 7, title: '完成测试', status: 'open', sourceRoom: 'room-a', assignee: null, due: null }];
	}
	throw new Error(`Unexpected query: ${sql}`);
};

const { executePomeloTool } = require('../src/modules/assistant/tools/pomelo-tools');
const call = (userId, name, args) => executePomeloTool({ userId, currentRoom: 'room-a' }, { name, args });

(async () => {
	const first = await call(1, 'search_messages', { query: '100%', limit: 1 });
	assert.deepEqual(first.matches.map(item => item.id), [11]);
	assert.equal(first.hasMore, true);
	assert.equal(first.nextBeforeId, 11);
	assert.ok(calls.some(item => item.sql.includes("m.content like ? escape '!'") && item.values.includes('%100!%%')));
	const second = await call(1, 'search_messages', { query: '100%', beforeId: 11 });
	assert.deepEqual(second.matches.map(item => item.id), [10]);
	await assert.rejects(call(2, 'search_messages', { query: '100%' }), error => error.code === 'TARGET_UNAVAILABLE');
	const context = await call(1, 'get_message_context', { messageId: 11, before: 1, after: 1 });
	assert.deepEqual(context.messages.map(item => item.id), [10, 11, 12]);
	await assert.rejects(call(2, 'get_message_context', { messageId: 11 }), error => error.code === 'TARGET_UNAVAILABLE');
	assert.deepEqual((await call(1, 'list_my_tasks', { status: 'open' })).tasks.map(item => item.id), [7]);
	console.log('[agent-read-tools-test] all assertions passed');
	process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
