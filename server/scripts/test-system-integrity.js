/* Behavioral integration tests against an explicitly isolated MySQL/Redis target. */
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

if (!process.env.DATABASE_URL_TEST || !process.env.REDIS_URL_TEST)
	throw new Error('DATABASE_URL_TEST and REDIS_URL_TEST are required');
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = process.env.REDIS_URL_TEST;
process.env.REDIS_KEY_PREFIX = `system-test:${Date.now()}:${process.pid}:`;
process.env.JWT_SECRET = 'isolated-system-regression-secret';
process.env.REQUEST_LOGS = 'false';
process.env.DEEPSEEK_API_KEY = '';
// This suite stresses protocol/transaction behavior; admission defaults are tested separately.
for (const name of ['MESSAGE_USER_RATE', 'MESSAGE_USER_BURST', 'MESSAGE_PRIVATE_RATE', 'MESSAGE_PRIVATE_BURST', 'MESSAGE_GROUP_RATE', 'MESSAGE_GROUP_BURST', 'MESSAGE_GLOBAL_RATE', 'MESSAGE_GLOBAL_BURST'])
	process.env[name] = '10000';
require('ts-node/register/transpile-only');

// Track actual periodic work and network attempts during module loading.
const activeTimers = new Set();
const originalSetInterval = global.setInterval, originalClearInterval = global.clearInterval;
global.setInterval = (...args) => { const timer = originalSetInterval(...args); activeTimers.add(timer); return timer; };
global.clearInterval = timer => { activeTimers.delete(timer); return originalClearInterval(timer); };
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
let importConnections = 0;
net.Socket.prototype.connect = function (...args) { importConnections++; return originalConnect.apply(this, args); };

const { initDatabase, default: db } = require('../src/infrastructure/database');
const { Query } = require('../src/infrastructure/database-query');
const { better_chat } = require('../src/infrastructure/redis');
const { default: app, registerAppRoutes } = require('../src/controller/app');
const { flushMessageOutbox } = require('../src/modules/messaging/outbox');
const { rtcCalls } = require('../src/composition');
const { createCall, getCall, transitionCall } = rtcCalls;
const WebSocket = require('ws');
const { startBackgroundServices, stopBackgroundServices } = require('../src/runtime');
net.Socket.prototype.connect = originalConnect;
assert.equal(importConnections, 0, 'imports must not open Redis or background sockets');
assert.equal(activeTimers.size, 0, 'imports must not start periodic work');
const server = http.createServer(app);
require('express-ws')(app, server);
registerAppRoutes();
const sockets = [];
const uploadedDirs = [];
let base;
const request = async (endpoint, data, token, method = data === undefined ? 'GET' : 'POST') => {
	const res = await fetch(`${base}/api/chat/v1${endpoint}`, {
		method,
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {})
		},
		body: data === undefined ? undefined : JSON.stringify(data)
	});
	return { status: res.status, ...(await res.json()) };
};
const frameSocket = async (url, token) => {
	const ws = new WebSocket(url, token ? ['pomelo-token', token] : undefined);
	const frames = [];
	ws.on('message', data => frames.push(JSON.parse(data.toString())));
	sockets.push(ws);
	await once(ws, 'open');
	return { ws, frames };
};
const eventually = async fn => {
	for (let i = 0; i < 100; i++) {
		const value = await fn();
		if (value) return value;
		await new Promise(r => setTimeout(r, 50));
	}
	throw new Error('Condition did not become true');
};
const send = async (
	channel,
	content,
	type = 'text',
	clientMsgId = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`
) => {
	const start = channel.frames.length;
	channel.ws.send(JSON.stringify({ content, type, clientMsgId, fileSize: 999999 }));
	return eventually(() =>
		channel.frames
			.slice(start)
			.find(f => (f.name === 'ack' || f.name === 'error') && f.client_msg_id === clientMsgId)
	);
};

(async () => {
	await initDatabase();
	await initDatabase();
	const initialEndListeners = better_chat.listenerCount('end');
	await Promise.all([startBackgroundServices(), startBackgroundServices()]);
	assert.equal(activeTimers.size, 5, 'exactly one session, call, outbox, pressure and receipt timer');
	assert.equal(better_chat.listenerCount('end'), initialEndListeners + 3);
	await Promise.all([stopBackgroundServices(), stopBackgroundServices()]);
	assert.equal(activeTimers.size, 0, 'shutdown removes every periodic worker');
	assert.equal(better_chat.listenerCount('end'), initialEndListeners, 'shutdown removes subscription listeners');
	await startBackgroundServices();
	assert.equal(activeTimers.size, 5, 'runtime can restart without duplicate workers');
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	base = `http://127.0.0.1:${server.address().port}`;
	const wsBase = base.replace('http:', 'ws:') + '/api/chat/v1';
	const stamp = `${Date.now()}${process.pid}`;
	const makeUser = async index => {
		const username = `system_${stamp}_${index}`,
			password = 'Test123456!';
		const phone = `13${String(BigInt(stamp) + BigInt(index)).slice(-9)}`;
		const registered = await request('/auth/register', {
			username,
			password,
			phone,
			avatar: 'https://ui-avatars.com/api/?name=test'
		});
		assert.equal(registered.code, 200, JSON.stringify(registered));
		const logged = await request('/auth/login', { username, password });
		assert.equal(logged.code, 200);
		return { username, password, phone, ...logged.data.info, token: logged.data.token };
	};
	const a = await makeUser(1),
		b = await makeUser(2),
		outsider = await makeUser(3);
	const phoneRace = await Promise.all(
		[4, 5].map(i =>
			request('/auth/register', {
				username: 'race_' + stamp + '_' + i,
				password: 'Race123!',
				phone: '13' + String(BigInt(stamp) + 6n).slice(-9),
				avatar: ''
			})
		)
	);
	assert.equal(phoneRace.filter(r => r.code === 200).length, 1);
	const orphan = await Query(
		'SELECT u.id FROM user u LEFT JOIN friend_group fg ON fg.user_id = u.id WHERE u.username LIKE ? AND fg.id IS NULL',
		['race_' + stamp + '%']
	);
	assert.equal(orphan.length, 0);
	assert.equal(
		(await request('/friend/add_friend', { id: b.id, username: b.username }, a.token)).code,
		200
	);
	const friend = (
		await Query('SELECT * FROM friend WHERE owner_id = ? AND user_id = ?', [a.id, b.id])
	)[0];
	const room = friend.room;
	await request('/friend/create_group', { name: 'moved' }, a.token);
	const groups = await Query('SELECT id FROM friend_group WHERE user_id = ? ORDER BY id DESC', [
		a.id
	]);
	await Query('UPDATE friend SET group_id = ? WHERE id = ?', [groups[0].id, friend.id]);
	assert.notEqual(
		(await request('/friend/add_friend', { id: b.id, username: b.username }, a.token)).code,
		200
	);
	assert.equal(
		(
			await Query('SELECT COUNT(*) AS total FROM friend WHERE owner_id = ? AND user_id = ?', [
				a.id,
				b.id
			])
		)[0].total,
		1
	);
	assert.equal(
		(
			await request(
				'/group/create_group',
				{ name: 'system group', members: [{ user_id: b.id, username: b.username }] },
				a.token
			)
		).code,
		200
	);
	const group = (await Query('SELECT * FROM group_chat WHERE creator_id = ?', [a.id]))[0];
	const groupConversation = (
		await Query('SELECT * FROM conversation WHERE room = ?', [group.room])
	)[0];
	assert.equal(groupConversation.last_seq, 1);
	assert.ok(groupConversation.last_message_id);
	const groupWs = await frameSocket(
		`${wsBase}/message/connect_chat?room=${group.room}&id=${a.id}&type=group`,
		a.token
	);
	assert.equal((await send(groupWs, 'second group message')).room_seq, 2);
	const connect = user =>
		frameSocket(
			`${wsBase}/message/connect_chat?room=${room}&id=${user.id}&type=private`,
			user.token
		);
	const ca = await connect(a),
		cb = await connect(b);
	await eventually(() => ca.frames.find(f => f.name === 'history'));
	const first = await send(ca, 'first');
	assert.equal(first.name, 'ack');
	const oldPublish = better_chat.publish.bind(better_chat);
	better_chat.publish = async (channel, ...args) => {
		if (channel.endsWith('pomelo:message:fanout'))
			throw new Error('Injected Redis delivery outage');
		return oldPublish(channel, ...args);
	};
	const ack = await send(ca, 'durable while Redis delivery fails', 'text', 'system_durable_key');
	assert.equal(ack.name, 'ack');
	await eventually(
		async () =>
			(
				await Query('SELECT * FROM message_outbox WHERE message_id = ? AND delivered_at IS NULL', [
					ack.id
				])
			).length
	);
	better_chat.publish = oldPublish;
	await Query(
		'UPDATE message_outbox SET next_attempt_at = CURRENT_TIMESTAMP WHERE message_id = ?',
		[ack.id]
	);
	await eventually(async () => {
		await flushMessageOutbox();
		return cb.frames.find(f => f.id === ack.id && f.content);
	});
	assert.equal(
		(await send(ca, 'durable while Redis delivery fails', 'text', 'system_durable_key')).id,
		ack.id
	);
	assert.equal((await send(ca, 'different text', 'text', 'system_durable_key')).name, 'error');
	const bytes = Buffer.from('owned attachment'),
		hash = createHash('md5').update(bytes).digest('hex');
	const verified = await request(
		'/file/verify_file',
		{ fileHash: hash, totalCount: 1, extname: 'txt' },
		a.token
	);
	assert.equal(verified.status, 200);
	const form = new FormData();
	form.set('chunk', new Blob([bytes], { type: 'text/plain' }), 'chunk.txt');
	for (const [key, value] of Object.entries({
		fileHash: hash,
		extname: 'txt',
		chunkIndex: '1',
		uploadToken: verified.data.uploadToken
	}))
		form.set(key, value);
	const upload = await fetch(base + '/api/chat/v1/file/upload_chunk', {
		method: 'POST',
		headers: { Authorization: `Bearer ${a.token}` },
		body: form
	});
	assert.equal(upload.status, 200, await upload.text());
	const merged = await request(
		'/file/merge_chunk',
		{ fileHash: hash, extname: 'txt', uploadToken: verified.data.uploadToken },
		a.token
	);
	assert.equal(merged.code, 200, JSON.stringify(merged));
	const filePath = merged.data.filePath;
	uploadedDirs.push(path.resolve('uploads', String(a.id)));
	assert.equal(
		(await request('/file/verify_file', { fileHash: hash, totalCount: 1, extname: 'txt' }, a.token))
			.status,
		200
	);
	assert.equal((await send(cb, `mention ${filePath}`)).name, 'ack');
	assert.equal(
		(await fetch(base + filePath, { headers: { Authorization: `Bearer ${b.token}` } })).status,
		404
	);
	assert.equal((await send(cb, filePath, 'file')).name, 'error');
	assert.equal((await send(ca, filePath, 'file')).name, 'ack');
	assert.equal(
		(
			await fetch(base + filePath, {
				method: 'HEAD',
				headers: { Authorization: `Bearer ${b.token}` }
			})
		).status,
		200
	);
	assert.equal(
		(await fetch(base + filePath, { headers: { Authorization: `Bearer ${outsider.token}` } }))
			.status,
		404
	);
	assert.equal(
		(
			await Query(
				'SELECT file_size FROM message WHERE sender_id = ? AND content = ? AND media_type = ?',
				[a.id, filePath, 'file']
			)
		)[0].file_size,
		bytes.length
	);
	await Query('DELETE FROM file_metadata WHERE owner_id = ?', [a.id]).catch(() => {});
	assert.equal(
		(await request('/file/verify_file', { fileHash: hash, totalCount: 1, extname: 'txt' }, a.token))
			.code,
		6001
	);
	for (let i = 0; i < 85; i++) assert.equal((await send(ca, `gap-${i}`)).name, 'ack');
	const catchup = await request(
		`/message/history?room=${room}&type=private&afterSeq=0&limit=80`,
		undefined,
		b.token
	);
	assert.equal(catchup.data.messages.length, 80);
	assert.equal(catchup.data.hasMore, true);
	const tail = await request(
		`/message/history?room=${room}&type=private&afterSeq=${catchup.data.messages.at(-1).room_seq}&limit=80`,
		undefined,
		b.token
	);
	assert.ok(tail.data.messages.length > 0);

    const searchGet = (params, token = a.token) => request('/message/search?' + new URLSearchParams({ room, type: 'private', ...params }), undefined, token);
    const resolve = (ids, token = a.token) => request('/message/resolve', { room, type: 'private', clientMsgIds: ids }, token);
    assert.deepEqual((await resolve(['system_durable_key'])).data.messages.map(m => m.id), [ack.id]);
    assert.equal((await resolve(['system_durable_key'], b.token)).data.messages.length, 0);
    assert.equal((await resolve(['system_durable_key'], outsider.token)).status, 404);
    assert.equal((await resolve(Array(101).fill('system_durable_key'))).status, 400);
    assert.equal((await resolve(['bad'])).status, 400);
    const literal = await send(ca, '搜索字面 100% _! 中文', 'text', 'search_literal_key');
    const literalResult = await searchGet({ query: '100% _!' });
    assert.deepEqual(literalResult.data.messages.map(m => m.id), [literal.id]);
    assert.equal((await searchGet({ query: '搜索', senderId: String(b.id) })).data.messages.length, 0);
    assert.equal((await searchGet({ query: 'gap-', limit: '20' })).data.messages.length, 20);
    const pageOne = await searchGet({ query: 'gap-', limit: '20' });
    const pageTwo = await searchGet({ query: 'gap-', limit: '20', beforeId: String(pageOne.data.nextBeforeId) });
    assert.equal(new Set([...pageOne.data.messages, ...pageTwo.data.messages].map(m => m.id)).size, 40);
    assert.equal((await searchGet({ query: 'gap-' }, outsider.token)).status, 404);
    assert.equal((await searchGet({ since: '2026-02-30' })).status, 400);
    assert.equal((await searchGet({ since: '2026-10-02', until: '2026-10-01' })).status, 400);
    assert.equal((await searchGet({ limit: '51' })).status, 400);
    assert.equal((await searchGet({ mediaType: 'file', query: 'text' })).status, 400);
    assert.ok((await searchGet({ mediaType: 'file' })).data.messages.every(m => m.type === 'file'));
    const targetContext = await request(`/message/context?room=${room}&type=private&messageId=${first.id}`, undefined, a.token);
    assert.equal(targetContext.code, 200);
    assert.ok(targetContext.data.messages.some(m => m.id === first.id));
    assert.ok(targetContext.data.hasAfter);
    assert.equal((await request(`/message/context?room=${room}&type=private&messageId=${first.id}`, undefined, outsider.token)).status, 404);
    assert.equal((await request(`/message/context?room=${group.room}&type=group&messageId=${first.id}`, undefined, a.token)).status, 404);
    assert.equal((await request(`/message/search?room=${group.room}&type=group&query=second`, undefined, b.token)).data.messages.length, 1);
    assert.equal((await request(`/message/search?room=${group.room}&type=group&query=second`, undefined, outsider.token)).status, 404);
    await Query('UPDATE message SET created_at = TIMESTAMPADD(SECOND, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) - 28800, ?) WHERE id = ?', ['2026-10-01 23:59:59', literal.id]);
    assert.equal((await searchGet({ query: '搜索字面', since: '2026-10-01', until: '2026-10-01' })).data.messages.length, 1);
    assert.equal((await searchGet({ query: '搜索字面', since: '2026-10-02' })).data.messages.length, 0);
	const receiptsBefore = ca.frames.filter(frame => frame.name === 'read_receipt').length;
	assert.notEqual((await request('/message/read', { room, type: 'private', roomSeq: 50 }, outsider.token)).code, 200);
	assert.equal(ca.frames.filter(frame => frame.name === 'read_receipt').length, receiptsBefore);
	assert.equal((await request('/message/read', { room, type: 'private', roomSeq: -1 }, b.token)).code, 1003);
	assert.equal((await request('/message/read', { room, type: 'private', roomSeq: 50 }, b.token)).data.roomSeq, 50);
	await eventually(() => ca.frames.some(frame => frame.name === 'read_receipt' && Number(frame.userId) === b.id && frame.roomSeq === 50));
	assert.equal((await request('/message/read', { room, type: 'private', roomSeq: 1 }, b.token)).data.roomSeq, 50, 'stale reads never regress the published cursor');
	const senderHistory = await request(`/message/history?room=${room}&type=private&limit=1`, undefined, a.token);
	assert.equal(senderHistory.data.peerReadSeq, 50, 'offline history restores peer read progress');
	const reconnected = await frameSocket(`${wsBase}/message/connect_chat?room=${room}&id=${a.id}&type=private`, a.token);
	await eventually(() => reconnected.frames.some(frame => frame.name === 'history'));
	assert.equal(reconnected.frames.find(frame => frame.name === 'history').peerReadSeq, 50);
	assert.equal(
		(
			await Query(
				'SELECT last_read_seq FROM conversation_read cr JOIN conversation c ON c.id = cr.conversation_id WHERE c.room = ? AND cr.user_id = ?',
				[room, b.id]
			)
		)[0].last_read_seq,
		50
	);
	assert.ok(
		(
			await Query(
				'SELECT COUNT(*) AS total FROM message WHERE room = ? AND receiver_id = ? AND room_seq > 50 AND status = 0',
				[room, b.id]
			)
		)[0].total > 0
	);
	const latest = (await Query('SELECT * FROM conversation WHERE room = ?', [room]))[0];
	const readMessage = (
		await Query('SELECT id FROM message WHERE room = ? AND room_seq = 50', [room])
	)[0];
	await Query('UPDATE message SET room_seq = id');
	await Query(
		'UPDATE conversation_read cr JOIN conversation c ON c.id = cr.conversation_id SET cr.last_read_seq = ? WHERE c.room = ? AND cr.user_id = ?',
		[readMessage.id, room, b.id]
	);
	await Query('DELETE FROM schema_migrations WHERE id = ?', ['system_integrity_v1']);
	await initDatabase();
	assert.equal(
		(await Query('SELECT last_seq FROM conversation WHERE room = ?', [room]))[0].last_seq,
		latest.last_seq
	);
	assert.equal(
		(
			await Query(
				'SELECT MAX(room_seq) AS max_seq, COUNT(*) AS total FROM message WHERE room = ?',
				[group.room]
			)
		)[0].max_seq,
		2
	);
	assert.equal(
		(
			await Query(
				'SELECT last_read_seq FROM conversation_read cr JOIN conversation c ON c.id = cr.conversation_id WHERE c.room = ? AND cr.user_id = ?',
				[room, b.id]
			)
		)[0].last_read_seq,
		50
	);
	const na = await frameSocket(
		`${wsBase}/auth/user_channel?username=${a.username}&token=${encodeURIComponent(a.token)}`
	);
	const nb = await frameSocket(
		`${wsBase}/auth/user_channel?username=${b.username}&token=${encodeURIComponent(b.token)}`
	);
	await eventually(() => better_chat.get(`presence:${b.username}`));
	const invited = await request(
		'/rtc/invite',
		{ room, type: 'private', mode: 'private_audio' },
		a.token
	);
	assert.equal(invited.code, 200);
	const callId = invited.data.callId;
	assert.notEqual((await request('/rtc/accept', { callId }, outsider.token)).code, 200);
	assert.equal((await request('/rtc/accept', { callId }, b.token)).code, 200);
	await request('/rtc/end', { callId }, b.token);
	assert.equal(await better_chat.get(`rtc:busy:${a.username}`), null);
	assert.equal((await getCall(callId)).status, 'ended');
	const ring = await request(
		'/rtc/invite',
		{ room, type: 'private', mode: 'private_audio' },
		a.token
	);
	assert.equal(ring.code, 200);
	const expired = await getCall(ring.data.callId);
	expired.expiresAt = 0;
	await better_chat.set(`rtc:call:${expired.id}`, JSON.stringify(expired));
	await transitionCall(expired.id, a.username, 'timeout');
	assert.equal(await better_chat.get(`rtc:busy:${b.username}`), null);
	const groupCall = await createCall(group.room, 'group', 'group_audio', a.username, [
		b.username,
		outsider.username
	]);
	const activeGroup = await transitionCall(groupCall.id, b.username, 'accept');
	assert.equal(activeGroup.members[outsider.username], 'invited');
	activeGroup.ringUntil = 0;
	await better_chat.set(`rtc:call:${groupCall.id}`, JSON.stringify(activeGroup));
	const timedGroup = await transitionCall(groupCall.id, a.username, 'timeout');
	assert.equal(timedGroup.status, 'active');
	assert.equal(timedGroup.members[outsider.username], 'left');
	assert.equal(await better_chat.get(`rtc:busy:${outsider.username}`), null);
	await transitionCall(groupCall.id, b.username, 'leave');
	await transitionCall(groupCall.id, a.username, 'leave');
	const replacement = await connect(b);
	assert.equal(cb.ws.readyState, WebSocket.OPEN, 'another tab must not evict the existing socket');
	assert.equal((await send(ca, 'replacement still receives')).name, 'ack');
	await eventually(() => replacement.frames.some(f => f.content === 'replacement still receives') && cb.frames.some(f => f.content === 'replacement still receives'));
	const newLogin = await request('/auth/login', { username: a.username, password: a.password });
	assert.notEqual(newLogin.data.token, a.token);
	await eventually(
		() => ca.ws.readyState === WebSocket.CLOSED && na.ws.readyState === WebSocket.CLOSED
	);
	a.token = newLogin.data.token;
	const fresh = await connect(a);
	await better_chat.publish(
		process.env.REDIS_KEY_PREFIX + 'pomelo:session:changed',
		JSON.stringify({ username: a.username, token: 'stale-token' })
	);
	assert.equal((await send(fresh, 'valid session survives stale event')).name, 'ack');
	await request(
		'/auth/forget_password',
		{ currentPassword: a.password, password: 'NewTest123!' },
		a.token
	);
	await eventually(() => fresh.ws.readyState === WebSocket.CLOSED);
	const blocker = await new Promise((resolve, reject) =>
		db.getConnection((err, connection) => (err ? reject(err) : resolve(connection)))
	);
	const blockedQuery = (sql, values) =>
		new Promise((resolve, reject) =>
			blocker.query(sql, values, (err, result) => (err ? reject(err) : resolve(result)))
		);
	await blockedQuery('START TRANSACTION');
	await blockedQuery('SELECT id FROM conversation WHERE room = ? FOR UPDATE', [room]);
	replacement.ws.send(
		JSON.stringify({
			content: 'revoked while DB lock held',
			type: 'text',
			clientMsgId: 'revoked_blocked_key'
		})
	);
	await new Promise(resolve => setTimeout(resolve, 150));
	await request('/auth/logout', {}, b.token);
	await blockedQuery('COMMIT');
	blocker.release();
	await new Promise(resolve => setTimeout(resolve, 150));
	assert.equal(
		(await Query('SELECT id FROM message WHERE client_msg_id = ?', ['revoked_blocked_key'])).length,
		0
	);
	await eventually(
		() => replacement.ws.readyState === WebSocket.CLOSED && nb.ws.readyState === WebSocket.CLOSED
	);
	await verifyServerShutdown(outsider);
	console.log(
		'[system-integrity] real MySQL/Redis: attachment forgery, metadata repair, outbox recovery, idempotency, >80 catchup, read monotonicity, call lifecycle, replacement and session revocation passed'
	);
})().then(
	() => finish(0),
	err => {
		console.error(err);
		finish(1);
	}
);

async function finish(code) {
	try {
		await stopBackgroundServices();
		assert.equal(activeTimers.size, 0, 'shutdown also removes active presence heartbeats');
		assert.equal(require('../src/modules/realtime/connections').notificationUsers().length, 0);
		for (const ws of sockets) assert.equal(ws.readyState, WebSocket.CLOSED);
	} catch (error) { console.error('[runtime cleanup]', error); code = 1; }
	for (const ws of sockets) ws.terminate();
	server.close();
	for (const directory of uploadedDirs) {
		const uploads = path.resolve('uploads') + path.sep;
		if (directory.startsWith(uploads) && /^\d+$/.test(path.basename(directory)))
			await fs.rm(directory, { recursive: true, force: true });
	}
	await better_chat.quit().catch(() => {});
	db.end();
	process.exit(code);
}

async function verifyServerShutdown(user) {
	const { spawn } = require('node:child_process');
	const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', `
		const { server, stopServer } = require('./src/index');
		server.once('listening', () => process.send({ port: server.address().port }));
		process.on('message', async () => {
			try { await Promise.all([stopServer(), stopServer()]); process.disconnect(); }
			catch (error) { console.error(error); process.exit(1); }
		});
	`], { cwd: process.cwd(), env: { ...process.env, PORT: '0' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
	let errorLog = '';
	child.stderr.on('data', data => { errorLog += data.toString(); });
	const exited = once(child, 'exit');
	const deadline = setTimeout(() => child.kill(), 20000);
	try {
		const [ready] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`Server exited before startup: ${errorLog}`); })]);
		const notification = await frameSocket(`ws://127.0.0.1:${ready.port}/api/chat/v1/auth/user_channel?username=${encodeURIComponent(user.username)}&token=${encodeURIComponent(user.token)}`);
		await eventually(() => better_chat.get(`presence:${user.username}`));
		child.send('shutdown');
		const [code, signal] = await exited;
		assert.equal(signal, null, `Shutdown exceeded deadline: ${errorLog}`);
		assert.equal(code, 0, `Complete server shutdown failed: ${errorLog}`);
		await eventually(() => notification.ws.readyState === WebSocket.CLOSED);
		assert.equal(await better_chat.get(`presence:${user.username}`), null);
	} finally { clearTimeout(deadline); if (child.exitCode === null && child.signalCode === null) child.kill(); }
}
