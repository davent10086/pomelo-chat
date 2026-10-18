#!/usr/bin/env node
const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const queryModule = require('../src/infrastructure/database-query');
const rows = new Map();
const tasks = new Map();
const sentMessages = new Set();
const savedMemories = new Map();
let nextTaskId = 1;
let nextMemoryId = 1;
let failCompletionOnce = false;
let overloadMessage = false;
const { MessageOverloadError } = require('../src/shared/overload');

queryModule.Query = async (sql, values = []) => {
	const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
	if (q.startsWith('insert into assistant_action')) {
		const [id, userId, type, payload, expiry] = values;
		rows.set(id, { id, userId, type, payload, selection: null, result: null, status: 'pending', expiresAt: new Date(expiry * 1000), leaseUntil: null });
		return { affectedRows: 1 };
	}
	if (q.startsWith('select id, user_id as userid')) {
		const row = rows.get(values[0]);
		return row && row.userId === values[1] ? [{ ...row }] : [];
	}
	if (q.includes("set status = 'executing', selection")) {
		const row = rows.get(values[1]);
		if (!row || row.userId !== values[2] || row.status !== 'pending' || row.expiresAt <= new Date()) return { affectedRows: 0 };
		row.status = 'executing'; row.selection = values[0]; row.leaseUntil = new Date(Date.now() + 45000);
		return { affectedRows: 1 };
	}
	if (q.includes('set lease_until = date_add')) {
		const row = rows.get(values[0]);
		if (!row || row.userId !== values[1] || row.status !== 'executing' || row.leaseUntil > new Date()) return { affectedRows: 0 };
		row.leaseUntil = new Date(Date.now() + 45000);
		return { affectedRows: 1 };
	}
	if (q.includes("set status = 'completed'")) {
		if (failCompletionOnce) { failCompletionOnce = false; throw new Error('injected result write failure'); }
		const row = rows.get(values[1]); row.status = 'completed'; row.result = values[0]; row.leaseUntil = null;
		return { affectedRows: 1 };
	}
	if (q.includes("set status = 'cancelled'")) {
		const row = rows.get(values[0]);
		if (row && row.userId === values[1] && row.status === 'pending' && row.expiresAt > new Date()) {
			row.status = 'cancelled';
			return { affectedRows: 1 };
		}
		return { affectedRows: 0 };
	}
	if (q.includes('set lease_until = now()')) {
		const row = rows.get(values[0]);
		if (row && row.userId === values[1]) row.leaseUntil = new Date(0);
		return { affectedRows: 1 };
	}
	if (q.startsWith('insert into assistant_task')) {
		const [userId, , actionId, index, title] = values;
		const key = `${userId}:${actionId}:${index}`;
		if (!tasks.has(key)) tasks.set(key, { id: nextTaskId++, title });
		return { affectedRows: 1 };
	}
	if (q.startsWith('select id from assistant_task')) return [tasks.get(`${values[0]}:${values[1]}:${values[2]}`)];
	if (q.startsWith('insert into assistant_memory')) {
		const key = `${values[0]}:${values[3] || savedMemories.size}`;
		if (!savedMemories.has(key)) savedMemories.set(key, { id: nextMemoryId++, userId: values[0], content: values[2] });
		return { affectedRows: 1 };
	}
	if (q.startsWith('select id, content from assistant_memory')) {
		return [...savedMemories.values()].filter(item => item.userId === values[0] && item.id === values[1]);
	}
	if (q.startsWith('delete from assistant_memory')) {
		const entry = [...savedMemories.entries()].find(([, item]) => item.userId === values[0] && item.id === values[1]);
		if (!entry) return { affectedRows: 0 };
		savedMemories.delete(entry[0]);
		return { affectedRows: 1 };
	}
	if (q.includes('from friend as f') && q.includes('inner join friend_group')) return values[0] === 991001 && values[1] === 'room-1' ? [{ ok: 1 }] : [];
	if (q.includes('from group_chat as gc') && q.includes('inner join group_members')) return [];
	if (q.startsWith('insert into mcp_audit_log')) return { affectedRows: 1 };
	throw new Error(`Unexpected query: ${sql}`);
};

const messageService = require('../src/modules/messaging/writes');
messageService.sendConfirmedTextMessage = async (_userId, _room, _type, _content, id) => {
	if (overloadMessage) throw new MessageOverloadError('outbox_pressure', 1500);
	sentMessages.add(id);
};
const { createPendingAction } = require('../src/modules/assistant/actions');
const { assistantHttp } = require('../src/composition');
const { cancelAction, confirmAction, getActionStatus, callAgentTool } = assistantHttp;
const { better_chat } = require('../src/infrastructure/redis');
const { externalMcpManager } = require('../src/modules/assistant/adapters/external-mcp');
const { canAccessRoom } = require('../src/modules/assistant/tools/pomelo-tools');
const invoke = async (handler, userId, body, params = {}) => {
	let response;
	const headers = {};
	await handler({ user: { id: userId }, body, params }, {
		setHeader: (name, value) => { headers[name] = value; },
		status: status => ({ json: value => { response = { ...value, httpStatus: status, headers }; } })
	});
	return response;
};

(async () => {
	const ownerId = 991001;
	const otherUserId = 991002;
	await assert.rejects(createPendingAction(ownerId, 'save_memory', { content: 'password: example' }), /Invalid memory proposal/);
	const proposedMemory = await invoke(callAgentTool, ownerId, { name: 'save_memory', args: { content: 'proposal only' } });
	assert.equal(proposedMemory.data.result.type, 'save_memory');
	assert.equal(savedMemories.size, 0);
	assert.equal((await invoke(cancelAction, ownerId, { confirmationId: proposedMemory.data.result.confirmationId })).code, 200);
	assert.equal(await canAccessRoom(ownerId, 'room-1'), true);
	assert.equal(await canAccessRoom(otherUserId, 'room-1'), false);
	const pending = await createPendingAction(ownerId, 'create_tasks', { todos: [{ title: 'action state test' }] });
	assert.equal((await invoke(cancelAction, otherUserId, { confirmationId: pending.confirmationId })).code, 1007);
	assert.equal((await invoke(cancelAction, ownerId, { confirmationId: pending.confirmationId })).code, 200);
	assert.equal((await invoke(confirmAction, ownerId, { confirmationId: pending.confirmationId })).code, 1007);

	const concurrent = await createPendingAction(ownerId, 'create_tasks', { todos: [{ title: 'concurrent cancellation test' }] });
	const cancellations = await Promise.all([
		invoke(cancelAction, ownerId, { confirmationId: concurrent.confirmationId }),
		invoke(cancelAction, ownerId, { confirmationId: concurrent.confirmationId })
	]);
	assert.equal(cancellations.filter(item => item.code === 200).length, 1);
	const raceAction = await createPendingAction(ownerId, 'create_tasks', { todos: [{ title: 'confirm cancel race' }] });
	await Promise.all([
		invoke(confirmAction, ownerId, { confirmationId: raceAction.confirmationId }),
		invoke(cancelAction, ownerId, { confirmationId: raceAction.confirmationId })
	]);
	const raceRow = rows.get(raceAction.confirmationId);
	assert.ok(raceRow.status === 'completed' || raceRow.status === 'cancelled');
	assert.equal([...tasks.keys()].filter(key => key.includes(raceAction.confirmationId)).length, raceRow.status === 'completed' ? 1 : 0);
	const baselineTasks = tasks.size;

	const action = await createPendingAction(ownerId, 'create_tasks', { todos: [{ title: 'first' }, { title: 'second' }] });
	const id = action.confirmationId;
	assert.equal((await invoke(confirmAction, ownerId, { confirmationId: id, taskIndexes: [] })).code, 1003);
	assert.equal((await invoke(getActionStatus, otherUserId, {}, { id })).code, 1007);
	failCompletionOnce = true;
	assert.equal((await invoke(confirmAction, ownerId, { confirmationId: id, taskIndexes: [1] })).code, 1001);
	assert.equal(tasks.size, baselineTasks + 1);
	assert.equal((await invoke(confirmAction, ownerId, { confirmationId: id, taskIndexes: [0] })).code, 200);
	assert.equal(tasks.size, baselineTasks + 1);
	assert.equal(rows.get(id).status, 'completed');
	assert.equal((await invoke(confirmAction, ownerId, { confirmationId: id })).code, 200);
	assert.equal(tasks.size, baselineTasks + 1);

	const messageAction = await createPendingAction(ownerId, 'send_message', { room: 'room-1', chatType: 'private', content: 'hello' });
	overloadMessage = true;
	const busy = await invoke(confirmAction, ownerId, { confirmationId: messageAction.confirmationId });
	assert.equal(busy.httpStatus, 429);
	assert.equal(busy.code, 8001);
	assert.equal(busy.headers['Retry-After'], '2');
	assert.equal(sentMessages.size, 0);
	assert.equal(rows.get(messageAction.confirmationId).status, 'executing');
	assert.ok(rows.get(messageAction.confirmationId).leaseUntil <= new Date());
	overloadMessage = false;
	failCompletionOnce = true;
	assert.equal((await invoke(confirmAction, ownerId, { confirmationId: messageAction.confirmationId })).code, 1001);
	delete require.cache[require.resolve('../src/modules/assistant/actions')];
	const reloadedActions = require('../src/modules/assistant/actions');
	const {respond} = require('../src/infrastructure/http-outcome');
	const afterRestart = {confirmAction:async (req,res) => respond(res,await reloadedActions.confirmAction(req.user,req.body))};
	assert.equal((await invoke(afterRestart.confirmAction, ownerId, { confirmationId: messageAction.confirmationId })).code, 200);
	assert.equal(sentMessages.size, 1);

	const externalCalls = new Set();
	externalMcpManager.getTool = async () => ({
		serverName: 'test', requiresConfirmation: true, idempotencyKey: 'requestId',
		invoke: async args => { externalCalls.add(args.requestId); return { requestId: args.requestId }; }
	});
	await assert.rejects(externalMcpManager.executeConfirmedTool('mcp_test_write', {}, ownerId), /requires a confirmation id/);
	const externalAction = await createPendingAction(ownerId, 'external_mcp', { name: 'mcp_test_write', args: {} });
	failCompletionOnce = true;
	assert.equal((await invoke(confirmAction, ownerId, { confirmationId: externalAction.confirmationId })).code, 1001);
	assert.equal((await invoke(confirmAction, ownerId, { confirmationId: externalAction.confirmationId })).code, 200);
	assert.deepEqual([...externalCalls], [externalAction.confirmationId]);

	const memoryAction = await createPendingAction(ownerId, 'save_memory', { content: '请记住我的偏好', category: 'preference' });
	failCompletionOnce = true;
	assert.equal((await invoke(confirmAction, ownerId, { confirmationId: memoryAction.confirmationId })).code, 1001);
	assert.equal((await invoke(confirmAction, ownerId, { confirmationId: memoryAction.confirmationId })).code, 200);
	assert.equal(savedMemories.size, 1);
	const wildcardMemory = await createPendingAction(ownerId, 'save_memory', { content: '进度 80%', category: 'qa' });
	assert.equal((await invoke(confirmAction, ownerId, { confirmationId: wildcardMemory.confirmationId })).code, 200);
	const literalMemory = [...savedMemories.values()].find(item => item.content === '进度 80%');
	const retainedMemory = [...savedMemories.values()].find(item => item.content === '请记住我的偏好');
	await assert.rejects(createPendingAction(otherUserId, 'forget_memory', { id: literalMemory.id }), /Memory not found/);
	await assert.rejects(createPendingAction(ownerId, 'forget_memory', { query: '%' }), /Invalid memory deletion/);
	const forgetAction = await createPendingAction(ownerId, 'forget_memory', { id: literalMemory.id });
	assert.equal(forgetAction.payload.content, '进度 80%');
	assert.equal((await invoke(confirmAction, ownerId, { confirmationId: forgetAction.confirmationId })).data.deleted, 1);
	assert.ok([...savedMemories.values()].some(item => item.id === retainedMemory.id));
	const evicted = await createPendingAction(ownerId, 'create_tasks', { todos: [{ title: 'restored after redis eviction' }] });
	await better_chat.del(`assistant:pending-action:${evicted.confirmationId}`);
	assert.equal((await invoke(confirmAction, ownerId, { confirmationId: evicted.confirmationId })).code, 200);

	const expired = await createPendingAction(ownerId, 'create_tasks', { todos: [{ title: 'expired' }] });
	rows.get(expired.confirmationId).expiresAt = new Date(0);
	assert.equal((await invoke(confirmAction, ownerId, { confirmationId: expired.confirmationId })).data.status, 'expired');
	console.log('[agent-actions-test] all assertions passed');
	process.exit(0);
})().catch(error => { console.error('[agent-actions-test] failed:', error); process.exit(1); });
