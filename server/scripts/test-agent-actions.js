#!/usr/bin/env node
const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const {
	createPendingAction,
	cancelAction,
	confirmAction
} = require('../src/service/assistant/actions');

const invoke = async (handler, userId, body) => {
	let response;
	await handler(
		{ user: { id: userId }, body },
		{ json: value => { response = value; } }
	);
	return response;
};

(async () => {
	const ownerId = 991001;
	const otherUserId = 991002;
	const pending = await createPendingAction(ownerId, 'create_tasks', {
		todos: [{ title: 'action state test' }]
	});

	const crossUserCancel = await invoke(cancelAction, otherUserId, { confirmationId: pending.confirmationId });
	assert.equal(crossUserCancel.code, 1007);

	const cancelled = await invoke(cancelAction, ownerId, { confirmationId: pending.confirmationId });
	assert.equal(cancelled.code, 200);

	const confirmAfterCancel = await invoke(confirmAction, ownerId, { confirmationId: pending.confirmationId });
	assert.equal(confirmAfterCancel.code, 1007);

	const concurrent = await createPendingAction(ownerId, 'create_tasks', {
		todos: [{ title: 'concurrent cancellation test' }]
	});
	const results = await Promise.all([
		invoke(cancelAction, ownerId, { confirmationId: concurrent.confirmationId }),
		invoke(cancelAction, ownerId, { confirmationId: concurrent.confirmationId })
	]);
	assert.equal(results.filter(result => result.code === 200).length, 1);
	assert.equal(results.filter(result => result.code === 1007).length, 1);

	console.log('[agent-actions-test] all assertions passed');
	process.exit(0);
})().catch(error => {
	console.error('[agent-actions-test] failed:', error);
	process.exit(1);
});
