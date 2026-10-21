const { serverRequire, serverRoot: testServerRoot, repoRoot: testRepoRoot } = require("../../helpers/paths.cjs");
// Real isolated services: entry rejection, durable retry, receipts and HTTP semantics.
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
if (!process.env.DATABASE_URL_TEST || !process.env.REDIS_URL_TEST)
	throw Error('Isolated targets required');
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = process.env.REDIS_URL_TEST;
if (!process.env.TEST_REDIS_KEY_PREFIX) throw new Error('Use pnpm test:integration for isolated Redis');
process.env.REDIS_KEY_PREFIX = process.env.TEST_REDIS_KEY_PREFIX;
process.env.JWT_SECRET = 'isolated-overload-regression';
process.env.METRICS_TOKEN = 'isolated-overload-metrics';
process.env.REQUEST_LOGS = 'false';
process.env.DEEPSEEK_API_KEY = '';
process.env.AI_API_KEY = '';
process.env.DASHSCOPE_API_KEY = '';
process.env.API_RATE_LIMIT_MAX = '240';
serverRequire('ts-node/register/transpile-only');
const WS = serverRequire('ws');
const bcrypt = serverRequire('bcrypt');
const { initDatabase, default: db } = require("../../../server/src/infrastructure/database");
const { Query } = require("../../../server/src/infrastructure/database-query");
const { better_chat } = require("../../../server/src/infrastructure/redis");
const { consumeTokenBuckets } = require("../../../server/src/infrastructure/token-bucket");
const { default: app, registerAppRoutes } = require("../../../server/src/controller/app");
const { startBackgroundServices, stopBackgroundServices } = require("../../../server/src/runtime");
const { stopMessageOutbox } = require("../../../server/src/modules/messaging/outbox");
const { refreshMessagePressure } = require("../../../server/src/modules/messaging/pressure");
const { startMessageDelivery } = require("../../../server/src/modules/realtime/message-delivery");
const server = http.createServer(app);
serverRequire('express-ws')(app, server);
registerAppRoutes();
const sockets = [],
	results = {},
	fixtureUsers = [],
	fixtureRooms = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let base;
const request = async (route, token, body) => {
	const res = await fetch(base + '/api/chat/v1/' + route, {
		method: body ? 'POST' : 'GET',
		headers: {
			Authorization: `Bearer ${token || ''}`,
			...(body ? { 'Content-Type': 'application/json' } : {})
		},
		...(body ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(10000)
	});
	const json = await res.json();
	assert.equal(json.code, 200, `${route}: ${res.status}/${json.code}`);
	return json.data;
};
const eventually = async predicate => {
	for (let i = 0; i < 150; i++) {
		if (await predicate()) return;
		await sleep(20);
	}
	throw Error('Condition timed out');
};
const metrics = async token => {
	const response = await fetch(base + '/internal/metrics', {
		headers: token ? { Authorization: `Bearer ${token}` } : {}
	});
	return { status: response.status, text: await response.text() };
};
const metricValue = (text, name) =>
	Number(new RegExp(`^${name} ([0-9.e+-]+)$`, 'm').exec(text)?.[1] || 0);
function connect(auth, room) {
	return new Promise((resolve, reject) => {
		const ws = new WS(
			`${base.replace('http:', 'ws:')}/api/chat/v1/message/connect_chat?room=${encodeURIComponent(room)}&id=${auth.info.id}&type=private`,
			['pomelo-token', auth.token]
		);
		sockets.push(ws);
		const peer = { ws, frames: [], pending: new Map(), autoReceipt: false };
		const timer = setTimeout(() => reject(Error('history timeout')), 10000);
		ws.on('error', reject);
		ws.on('message', raw => {
			const frame = JSON.parse(raw);
			peer.frames.push(frame);
			if (frame.name === 'history') {
				clearTimeout(timer);
				resolve(peer);
			}
			if (frame.name === 'ack' || frame.name === 'error') {
				const finish = peer.pending.get(frame.client_msg_id);
				if (finish) {
					peer.pending.delete(frame.client_msg_id);
					finish(frame);
				}
			}
			if (peer.autoReceipt && frame.receipt)
				ws.send(JSON.stringify({ name: 'delivery_ack', receipt: frame.receipt }));
		});
	});
}
const send = (peer, id) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			peer.pending.delete(id);
			reject(Error('response timeout'));
		}, 10000);
		peer.pending.set(id, value => {
			clearTimeout(timer);
			resolve(value);
		});
		peer.ws.send(JSON.stringify({ content: id, type: 'text', clientMsgId: id }));
	});
async function main() {
	await initDatabase();
	await startBackgroundServices();
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${server.address().port}`;
	const bucket = { key: 'bucket:{test}:atomic', rate: 0.01, capacity: 5 };
	const decisions = await Promise.all(
		Array.from({ length: 40 }, () => consumeTokenBuckets([bucket]))
	);
	assert.equal(decisions.filter(n => n === 0).length, 5);
	const untouched = { key: 'bucket:{test}:untouched', rate: 1, capacity: 1 };
	assert.ok((await consumeTokenBuckets([bucket, untouched])) > 0);
	assert.equal(await consumeTokenBuckets([untouched]), 0);
	const refill = { key: 'bucket:{test}:refill', rate: 10, capacity: 1 };
	assert.equal(await consumeTokenBuckets([refill]), 0);
	assert.ok((await consumeTokenBuckets([refill])) > 0);
	await sleep(120);
	assert.equal(await consumeTokenBuckets([refill]), 0);
	assert.ok((await better_chat.pttl(refill.key)) > 0);
	// Separate TIME calls can complete out of order; old samples must never mint tokens.
	const readTime = better_chat.time;
	const times = ['1000', '1002', '1001', '1002'];
	better_chat.time = async () => [times.shift(), '0'];
	try {
		const ordered = { key: 'bucket:{test}:clock-order', rate: 1, capacity: 2 };
		for (let i = 0; i < 3; i++) assert.equal(await consumeTokenBuckets([ordered]), 0);
		assert.ok((await consumeTokenBuckets([ordered])) > 0);
	} finally { better_chat.time = readTime; }
	results.atomicBuckets = { attempts: 40, accepted: 5, partialSpending: false, refill: true, staleClockSafe: true };
	const password = 'OnlyForOverload123!',
		hash = await bcrypt.hash(password, 10),
		auth = [];
	const nonce = randomUUID().slice(0, 8);
	for (let i = 0; i < 2; i++) {
		const username = `overload_${nonce}_${i}`;
		const row = await Query('INSERT INTO user (username,password,phone,name) VALUES (?,?,?,?)', [
			username,
			hash,
			`${nonce}${i}`,
			username
		]);
		fixtureUsers.push(row.insertId);
		await Query('INSERT INTO friend_group (user_id,username,name) VALUES (?,?,?)', [
			row.insertId,
			username,
			'default'
		]);
		auth.push(await request('auth/login', undefined, { username, password }));
	}
	await request('friend/add_friend', auth[0].token, {
		id: auth[1].info.id,
		username: auth[1].info.username
	});
	const [{ room }] = await request('message/chat_list', auth[0].token);
	fixtureRooms.push(room);
	const a = await connect(auth[0], room),
		b = await connect(auth[1], room);
	assert.equal((await metrics()).status, 404);
	assert.equal((await metrics('wrong')).status, 404);
	const first = await send(a, 'overload-receipt-000');
	assert.equal(first.name, 'ack');
	await eventually(() => b.frames.some(f => f.client_msg_id === first.client_msg_id && f.receipt));
	const frame = b.frames.find(f => f.client_msg_id === first.client_msg_id && f.receipt);
	const received = async () =>
		metricValue(
			(await metrics(process.env.METRICS_TOKEN)).text,
			'pomelo_message_socket_receive_seconds_count'
		);
	const before = await received();
	a.ws.send(JSON.stringify({ name: 'delivery_ack', receipt: frame.receipt }));
	await sleep(30);
	assert.equal(await received(), before);
	b.ws.send(JSON.stringify({ name: 'delivery_ack', receipt: frame.receipt }));
	await eventually(async () => (await received()) === before + 1);
	b.ws.send(JSON.stringify({ name: 'delivery_ack', receipt: frame.receipt }));
	await sleep(30);
	assert.equal(await received(), before + 1);
	b.autoReceipt = true;
	process.env.MESSAGE_ROOM_QUEUE_MAX = '4';
	const burst = await Promise.all(
		Array.from({ length: 40 }, (_, i) => send(a, `overload-queue-${i}`))
	);
	const rejected = burst.filter(f => f.name === 'error');
	assert.ok(rejected.length > 0);
	assert.ok(
		rejected.every(f => f.code === 'MESSAGE_OVERLOADED' && f.retryable && f.retryAfterMs > 0)
	);
	const [count] = await Query(
		"SELECT COUNT(*) AS n FROM message WHERE client_msg_id LIKE 'overload-queue-%'"
	);
	assert.equal(Number(count.n), burst.filter(f => f.name === 'ack').length);
	results.queueBurst = { attempted: 40, committed: Number(count.n), rejected: rejected.length };
	process.env.MESSAGE_ROOM_QUEUE_MAX = '32';
	process.env.MESSAGE_USER_RATE = '.01';
	process.env.MESSAGE_USER_BURST = '1';
	await better_chat.del(`message:{admission}:user:${auth[0].info.id}`);
	assert.equal((await send(a, 'overload-token-first')).name, 'ack');
	const throttled = await Promise.all(
		Array.from({ length: 10 }, (_, i) => send(a, `overload-token-${i}`))
	);
	assert.ok(throttled.every(f => f.code === 'MESSAGE_OVERLOADED'));
	assert.equal(
		(await send(a, 'overload-token-first')).name,
		'ack',
		'committed retry bypasses new-message admission'
	);
	const [tokenCount] = await Query(
		"SELECT COUNT(*) AS n FROM message WHERE client_msg_id LIKE 'overload-token-%'"
	);
	assert.equal(Number(tokenCount.n), 1);
	results.tokenBurst = { accepted: 1, rejected: 10, duplicateRows: 0 };
	const originalEval = better_chat.eval;
	better_chat.eval = function (script, ...args) {
		return script.includes('local values')
			? Promise.reject(Error('injected admission outage'))
			: originalEval.call(this, script, ...args);
	};
	try {
		assert.equal((await send(a, 'overload-redis-denied')).code, 'MESSAGE_OVERLOADED');
		assert.equal((await send(a, 'overload-token-first')).name, 'ack');
		assert.equal(
			(await Query('SELECT id FROM message WHERE client_msg_id = ?', ['overload-redis-denied']))
				.length,
			0
		);
	} finally {
		better_chat.eval = originalEval;
	}
	results.admissionOutage = { rejectedBeforePersistence: true, committedRetryResolved: true };
	process.env.MESSAGE_USER_RATE = '5';
	process.env.MESSAGE_USER_BURST = '10';
	await better_chat.del(`message:{admission}:user:${auth[0].info.id}`);
	await eventually(
		async () =>
			!(await Query('SELECT COUNT(*) AS n FROM message_outbox WHERE delivered_at IS NULL'))[0].n
	);
	await stopMessageOutbox();
	assert.equal((await send(a, 'overload-backlog-first')).name, 'ack');
	process.env.MESSAGE_OUTBOX_MAX_PENDING = '1';
	await refreshMessagePressure();
	assert.equal((await send(a, 'overload-backlog-denied')).code, 'MESSAGE_OVERLOADED');
	assert.equal((await send(a, 'overload-backlog-first')).name, 'ack');
	assert.equal(
		(await Query('SELECT id FROM message WHERE client_msg_id = ?', ['overload-backlog-denied']))
			.length,
		0
	);
	process.env.MESSAGE_OUTBOX_MAX_PENDING = '500';
	await startMessageDelivery();
	await eventually(
		async () =>
			!(await Query('SELECT COUNT(*) AS n FROM message_outbox WHERE delivered_at IS NULL'))[0].n
	);
	await refreshMessagePressure();
	const scrape = await metrics(process.env.METRICS_TOKEN);
	assert.equal(scrape.status, 200);
	assert.equal(metricValue(scrape.text, 'pomelo_outbox_pending'), 0);
	assert.ok(metricValue(scrape.text, 'pomelo_message_socket_receive_seconds_count') > 0);
	assert.ok(metricValue(scrape.text, 'pomelo_message_created_to_receive_seconds_count') > 0);
	assert.ok(!scrape.text.includes(auth[0].info.username) && !scrape.text.includes(room));
	const statuses = {},
		headers = [];
	await Promise.all(
		Array.from({ length: 20 }, async () => {
			for (let i = 0; i < 15; i++) {
				const res = await fetch(base + '/api/chat/v1/message/chat_list', {
					headers: { Authorization: `Bearer ${auth[0].token}` }
				});
				statuses[res.status] = (statuses[res.status] || 0) + 1;
				if (res.status === 429) headers.push(Number(res.headers.get('Retry-After')));
				await res.arrayBuffer();
			}
		})
	);
	assert.ok(statuses[200] > 0 && statuses[429] > 0 && !statuses[400]);
	assert.ok(headers.every(n => n > 0));
	results.http = statuses;
	results.metrics = { actualReceipts: await received(), pendingOutbox: 0, authenticated: true };
	console.log(JSON.stringify({ messageOverload: results }));
}
main()
	.catch(error => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		for (const ws of sockets) ws.terminate();
		await stopBackgroundServices();
		if (server.listening) await new Promise(resolve => server.close(resolve));
		if (fixtureRooms.length) {
			await Query('DELETE FROM message WHERE room IN (?)', [fixtureRooms]);
			await Query('DELETE FROM message_statistics WHERE room IN (?)', [fixtureRooms]);
			await Query('DELETE FROM conversation WHERE room IN (?)', [fixtureRooms]);
		}
		if (fixtureUsers.length) {
			await Query('DELETE FROM friend WHERE owner_id IN (?) OR user_id IN (?)', [
				fixtureUsers,
				fixtureUsers
			]);
			await Query('DELETE FROM friend_group WHERE user_id IN (?)', [fixtureUsers]);
			await Query('DELETE FROM user WHERE id IN (?)', [fixtureUsers]);
		}
		const cleanup = better_chat.duplicate({ keyPrefix: '' });
		try {
			await cleanup.connect();
			let cursor = '0';
			do {
				const [next, keys] = await cleanup.scan(
					cursor,
					'MATCH',
					`${process.env.REDIS_KEY_PREFIX}*`,
					'COUNT',
					100
				);
				cursor = next;
				if (keys.length) await cleanup.del(...keys);
			} while (cursor !== '0');
		} finally {
			cleanup.disconnect();
			better_chat.disconnect();
			await require("../../../server/src/infrastructure/database").closeDatabase();
		}
	});
