/* Behavior tests: real isolated MySQL, injected notification failures, competing workers. */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
if (!process.env.DATABASE_URL_TEST) throw new Error('DATABASE_URL_TEST is required');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'backend-reliability-test';
require('ts-node/register/transpile-only');
const { initDatabase, default: db } = require('../src/model/db');
const { Query, withTransaction } = require('../src/infrastructure/database-query');
const { persistMessage } = require('../src/service/message/persistence');
const { MessageOutboxWorker } = require('../src/service/message/outbox');
const { createFriendApplication, createGroupApplication } = require('../src/modules/social/public');
const { createHttpHandlers } = require('../src/modules/social/http');
const effects = {
	notifyUser: async () => {
		throw new Error('injected notification outage');
	},
	isOnline: () => false,
	initializeGroupMessage: persistMessage
};
const services = createHttpHandlers({
	friends: createFriendApplication(effects),
	groups: createGroupApplication(effects)
});
const friendService = services,
	groupService = services;
const { better_chat } = require('../src/utils/authenticate');
const prefix = `backend_${randomUUID().slice(0, 8)}`;
const workers = [];
const userIds = [];
const groupIds = [];
const logs = [];
const originalError = console.error;

const unhandled = [];
const onUnhandled = error => unhandled.push(error);
process.on('unhandledRejection', onUnhandled);
const response = () => {
	const result = {};
	return {
		result,
		status(code) {
			result.status = code;
			return this;
		},
		json(body) {
			result.body = body;
			return this;
		}
	};
};
const call = async (handler, user, body = {}, query = {}) => {
	const res = response();
	await handler({ user, body, query }, res);
	assert.ok(res.result.body, 'every branch must respond');
	return res.result;
};
const eventually = async predicate => {
	for (let i = 0; i < 150; i++) {
		if (await predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error('condition timed out');
};
const makeWorker = handler => {
	const worker = new MessageOutboxWorker(handler);
	workers.push(worker);
	worker.start();
	return worker;
};

async function main() {
	await initDatabase();
	await initDatabase();
	console.error = (...args) => logs.push(args.map(String).join(' '));

	const makeUser = async index => {
		const username = `${prefix}_${index}`;
		const inserted = await Query(
			'INSERT INTO user (username, password, phone, name) VALUES (?, ?, ?, ?)',
			[username, 'unused', `${prefix}_phone_${index}`, username]
		);
		userIds.push(inserted.insertId);
		const group = await Query(
			'INSERT INTO friend_group (user_id, username, name) VALUES (?, ?, ?)',
			[inserted.insertId, username, 'default']
		);
		return { id: inserted.insertId, username, name: username, groupId: group.insertId };
	};
	const owner = await makeUser(1),
		target = await makeUser(2),
		outsider = await makeUser(3);
	const {getPublicUserProfile} = require('../src/modules/identity/public');
	const profile = await getPublicUserProfile(owner.id);
	assert.deepEqual(Object.keys(profile).sort(), ['avatar','id','name','username']);
	assert.equal(await getPublicUserProfile(2147483647), null);
	const notifications = [];
	const originalPublish = better_chat.publish;
	better_chat.publish = async (_channel, raw) => {notifications.push(JSON.parse(raw)); return 1;};
	try {
		const {NotificationUser} = require('../src/modules/realtime/public');
		await NotificationUser({receiver_id:owner.id,name:'friendList'});
		await NotificationUser({receiver_id:2147483647,name:'friendList'});
		assert.equal(notifications.length,1);
		assert.equal(notifications[0].username,owner.username);
	} finally {better_chat.publish = originalPublish;}
	const friend = await Query(
		'INSERT INTO friend (owner_id, user_id, username, group_id, room, remark) VALUES (?, ?, ?, ?, ?, ?)',
		[owner.id, target.id, target.username, owner.groupId, randomUUID(), 'initial']
	);
	const update = body => call(friendService.updateFriend, owner, body);
	assert.equal(
		(await update({ friend_id: friend.insertId, remark: '', group_id: owner.groupId })).status,
		200,
		'empty remark is valid'
	);
	assert.equal(
		(await update({ friend_id: friend.insertId, remark: '', group_id: owner.groupId })).status,
		200,
		'unchanged update is successful'
	);
	assert.equal(
		(await update({ friend_id: friend.insertId, remark: 'forbidden', group_id: outsider.groupId }))
			.status,
		404
	);
	assert.equal(
		(
			await call(friendService.updateFriend, outsider, {
				friend_id: friend.insertId,
				remark: 'forbidden',
				group_id: outsider.groupId
			})
		).status,
		404
	);
	assert.equal(
		(await update({ friend_id: 2147483647, remark: 'missing', group_id: owner.groupId })).status,
		404
	);
	assert.equal(
		(await update({ friend_id: friend.insertId, remark: {}, group_id: owner.groupId })).status,
		400
	);
	const friendList = (await call(friendService.getFriendList, owner)).body.data;
	assert.equal(friendList[0].friend.length, 1);
	const usersPage1 = (
		await call(friendService.searchUser, owner, {}, { username: prefix, limit: '1' })
	).body.data;
	assert.equal(usersPage1.length, 1);
	assert.equal(usersPage1[0].id, target.id);
	assert.equal(usersPage1[0].status, true);
	const usersPage2 = (
		await call(
			friendService.searchUser,
			owner,
			{},
			{ username: prefix, limit: '1', afterId: String(target.id) }
		)
	).body.data;
	assert.equal(usersPage2[0].id, outsider.id);
	assert.equal(usersPage2[0].status, false);
	assert.equal(
		(await call(friendService.searchUser, owner, {}, { username: prefix, limit: '101' })).status,
		400
	);
	assert.equal(
		(await call(friendService.searchUser, owner, {}, { username: prefix, afterId: ['1', '2'] }))
			.status,
		400
	);

	const makeGroup = async suffix => {
		const room = randomUUID();
		const group = await Query('INSERT INTO group_chat (name, room, creator_id) VALUES (?, ?, ?)', [
			`${prefix}_${suffix}`,
			room,
			owner.id
		]);
		groupIds.push(group.insertId);
		await Query('INSERT INTO group_members (group_id, user_id, nickname) VALUES (?, ?, ?)', [
			group.insertId,
			owner.id,
			owner.username
		]);
		return { room, id: group.insertId };
	};
	const slow = await makeGroup('slow'),
		fast = await makeGroup('fast');
	assert.equal(
		(
			await call(groupService.inviteFriendToGroupChat, owner, {
				groupId: slow.id,
				invitationList: [{ user_id: target.id, username: target.username }]
			})
		).status,
		200
	);
	assert.equal(
		(await call(groupService.joinGroupChat, outsider, { group_id: slow.id })).status,
		200
	);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(unhandled.length, 0, 'notification rejections must be caught');
	assert.equal(logs.filter(line => line.includes('injected notification outage')).length, 2);
	const groupsPage1 = (
		await call(groupService.searchGroupChat, owner, {}, { name: prefix, limit: '1' })
	).body.data;
	assert.deepEqual(
		groupsPage1.map(group => [group.group_id, group.number, group.status]),
		[[slow.id, 3, true]]
	);
	const groupsPage2 = (
		await call(
			groupService.searchGroupChat,
			outsider,
			{},
			{ name: prefix, limit: '1', afterId: String(slow.id) }
		)
	).body.data;
	assert.deepEqual(
		groupsPage2.map(group => [group.group_id, group.number, group.status]),
		[[fast.id, 1, false]]
	);
	const literal = await makeGroup('literal%_!');
	assert.deepEqual(
		(
			await call(groupService.searchGroupChat, owner, {}, { name: `${prefix}_literal%_!` })
		).body.data.map(group => group.group_id),
		[literal.id]
	);

	const insertMessage = (group, content) =>
		withTransaction(query =>
			persistMessage(query, {
				sender_id: owner.id,
				receiver_id: group.id,
				room: group.room,
				content,
				type: 'group',
				media_type: 'text',
				file_size: 0,
				status: 0
			})
		);
	const slow1 = await insertMessage(slow, 'slow1'),
		slow2 = await insertMessage(slow, 'slow2');
	const fast1 = await insertMessage(fast, 'fast1'),
		fast2 = await insertMessage(fast, 'fast2');
	let releaseSlow;
	const gate = new Promise(resolve => {
		releaseSlow = resolve;
	});
	const deliveries = [];
	const handler = async id => {
		deliveries.push(id);
		if (id === slow1) await gate;
	};
	const first = makeWorker(handler),
		second = makeWorker(handler);
	const firstFlush = first.flush(),
		secondFlush = second.flush();
	try {
		await eventually(() => deliveries.includes(fast2));
		assert.equal(deliveries.filter(id => id === slow1).length, 1, 'competing workers claim once');
		assert.equal(deliveries.includes(slow2), false, 'room ordering survives a slow delivery');
		assert.ok(deliveries.indexOf(fast1) < deliveries.indexOf(fast2));
	} finally {
		releaseSlow();
	}
	await Promise.all([firstFlush, secondFlush]);
	await Promise.all([first.flush(), second.flush()]);
	await first.stop();
	await second.stop();
	assert.equal(deliveries.length, 4);
	assert.equal(new Set(deliveries).size, 4);
	assert.ok(deliveries.indexOf(slow1) < deliveries.indexOf(slow2));

	const failedId = await insertMessage(fast, 'retry');
	const nextId = await insertMessage(fast, 'after retry');
	let failures = 1;
	const retries = [];
	const retryWorker = makeWorker(async id => {
		retries.push(id);
		if (failures-- > 0) throw new Error('injected delivery outage');
	});
	await retryWorker.flush();
	const pending = (await Query('SELECT * FROM message_outbox WHERE message_id = ?', [failedId]))[0];
	assert.equal(pending.attempts, 1);
	assert.equal(pending.claim_token, null);
	assert.equal(pending.delivered_at, null);
	assert.deepEqual(retries, [failedId], 'failed head blocks later messages in its room');
	await Query(
		'UPDATE message_outbox SET next_attempt_at = NOW(), claim_token = ?, lease_until = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE message_id = ?',
		[randomUUID(), failedId]
	);
	await retryWorker.flush();
	await retryWorker.stop();
	assert.deepEqual(
		retries,
		[failedId, failedId, nextId],
		'expired lease is reclaimed before next message'
	);
	assert.ok(
		(await Query('SELECT delivered_at FROM message_outbox WHERE message_id = ?', [failedId]))[0]
			.delivered_at
	);

	const renewalId = await insertMessage(literal, 'renewed');
	let releaseRenewal, renewLease;
	const renewalGate = new Promise(resolve => {
		releaseRenewal = resolve;
	});
	const originalInterval = global.setInterval;
	global.setInterval = (callback, milliseconds, ...args) => {
		if (milliseconds === 20000) renewLease = callback;
		return originalInterval(callback, milliseconds, ...args);
	};
	const renewalWorker = makeWorker(async () => {
		await renewalGate;
	});
	const renewalFlush = renewalWorker.flush();
	try {
		await eventually(() => typeof renewLease === 'function');
		await Query(
			'UPDATE message_outbox SET lease_until = DATE_ADD(NOW(), INTERVAL 5 SECOND) WHERE message_id = ?',
			[renewalId]
		);
		renewLease();
		await eventually(
			async () =>
				(
					await Query(
						'SELECT TIMESTAMPDIFF(SECOND, NOW(), lease_until) AS remaining FROM message_outbox WHERE message_id = ?',
						[renewalId]
					)
				)[0].remaining > 50
		);
	} finally {
		global.setInterval = originalInterval;
		releaseRenewal();
	}
	await renewalFlush;
	await renewalWorker.stop();

	const fencedId = await insertMessage(literal, 'fenced');
	let releaseFence,
		fenceStarted = false;
	const fenceGate = new Promise(resolve => {
		releaseFence = resolve;
	});
	const fencedWorker = makeWorker(async () => {
		fenceStarted = true;
		await fenceGate;
	});
	const fencedFlush = fencedWorker.flush();
	const replacementToken = randomUUID();
	try {
		await eventually(() => fenceStarted);
		await Query(
			'UPDATE message_outbox SET claim_token = ?, lease_until = DATE_ADD(NOW(), INTERVAL 60 SECOND) WHERE message_id = ?',
			[replacementToken, fencedId]
		);
	} finally {
		releaseFence();
	}
	await fencedFlush;
	await fencedWorker.stop();
	const fenced = (await Query('SELECT * FROM message_outbox WHERE message_id = ?', [fencedId]))[0];
	assert.equal(fenced.delivered_at, null, 'stale worker cannot complete a replaced claim');
	assert.equal(fenced.claim_token, replacementToken);
	assert.equal(logs.filter(line => line.includes('recovery failed')).length, 0, logs.join('\n'));
	console.log(
		'[backend-reliability] responses, ownership, pagination, notification failure, competing workers, room order, slow-room isolation, retry, expired leases, renewal and fencing passed'
	);
}

main().then(
	() => finish(0),
	error => {
		originalError(error);
		return finish(1);
	}
);
async function finish(code) {
	console.error = originalError;
	await Promise.all(workers.map(worker => worker.stop()));
	process.off('unhandledRejection', onUnhandled);
	better_chat.disconnect();
	// The convenience runner drops its own DB; standalone runs only remove this run's records.
	try {
		if (userIds.length) await Query('DELETE FROM message WHERE sender_id IN (?)', [userIds]);
		if (groupIds.length) {
			await Query(
				'DELETE FROM message_statistics WHERE room IN (SELECT room FROM group_chat WHERE id IN (?))',
				[groupIds]
			);
			await Query(
				'DELETE FROM conversation WHERE room IN (SELECT room FROM group_chat WHERE id IN (?))',
				[groupIds]
			);
			await Query('DELETE FROM group_chat WHERE id IN (?)', [groupIds]);
		}
		if (userIds.length) {
			await Query('DELETE FROM friend WHERE owner_id IN (?)', [userIds]);
			await Query('DELETE FROM user WHERE id IN (?)', [userIds]);
		}
	} catch (error) {
		originalError('[backend-reliability] cleanup failed:', error);
		code = 1;
	}
	await new Promise(resolve => db.end(resolve));
	process.exitCode = code;
}
