// @tags regression reliability
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { serverRoot, serverRequire } = require('../../helpers/paths.cjs');
const { stopTree } = require('../../helpers/process.cjs');
const WebSocket = serverRequire('ws');

test('real TCP delay, lost ACK, reconnect, idempotent retry and backend restart preserve messages', { timeout: 60000 }, async () => {
	assert.ok(process.env.TEST_REDIS_KEY_PREFIX, 'use isolated integration runner');
	let child, backendPort, dropDownstream = false;
	const connections = new Set(), clients = new Set();
	const start = async () => {
		child = spawn(process.execPath, ['-e', `const {server,stopServer}=require('./dist/index.js'); server.once('listening',()=>process.send({port:server.address().port})); process.on('message',async()=>{await stopServer();process.disconnect();});`],
			{ cwd: serverRoot, env: { ...process.env, PORT: '0', REQUEST_LOGS: 'false' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
		let errors = ''; child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-2000); });
		backendPort = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`startup timeout: ${errors}`)), 15000);
			child.once('message', value => { clearTimeout(timer); resolve(value.port); });
			child.once('exit', code => { clearTimeout(timer); reject(new Error(`backend exited ${code}: ${errors}`)); });
			child.once('error', reject);
		});
	};
	const stop = async () => {
		if (!child || child.exitCode !== null) return;
		const done = new Promise(resolve => child.once('exit', resolve)); child.send('stop');
		const timer = setTimeout(() => void stopTree(child), 5000);
		await done; clearTimeout(timer);
	};
	// Delay real bytes in both directions. The proxy never fabricates API or WS frames.
	const proxy = net.createServer(client => {
		const upstream = net.connect(backendPort, '127.0.0.1');
		connections.add(client); connections.add(upstream);
		const relay = (from, to, downstream) => from.on('data', bytes => {
			from.pause();
			setTimeout(() => {
				if (to.destroyed || (downstream && dropDownstream)) { from.resume(); return; }
				if (to.write(bytes)) from.resume(); else to.once('drain', () => from.resume());
			}, 60);
		});
		relay(client, upstream, false); relay(upstream, client, true);
		for (const [a, b] of [[client, upstream], [upstream, client]]) {
			a.on('error', () => b.destroy()); a.on('close', () => { connections.delete(a); b.destroy(); });
		}
	});
	try {
		await start();
		await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
		const port = proxy.address().port, base = `http://127.0.0.1:${port}/api/chat/v1`;
		const http = async (path, data, token, method = 'POST') => {
			const response = await fetch(`${base}/${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
				...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(10000) });
			const result = await response.json(); assert.equal(result.code, 200, `${path}: ${JSON.stringify(result)}`); return result.data;
		};
		const stamp = String(Date.now());
		const create = async index => {
			const username = `fault_${stamp}_${index}`, password = 'NetworkTest123!';
			await http('auth/register', { username, password, phone: `13${(BigInt(stamp) + BigInt(index)).toString().slice(-9)}` });
			return http('auth/login', { username, password });
		};
		const a = await create(1), b = await create(2);
		await http('friend/add_friend', { id: b.info.id, username: b.info.username }, a.token);
		const room = (await http('message/chat_list', undefined, a.token, 'GET')).find(item => Number(item.receiver_id) === b.info.id).room;
		const connect = async user => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/api/chat/v1/message/connect_chat?room=${encodeURIComponent(room)}&id=${user.info.id}&type=private`, ['pomelo-token', user.token]);
			clients.add(ws); ws.on('error', () => {});
			await waitFrame(ws, frame => frame.name === 'history'); return ws;
		};
		const first = await connect(a);
		const original = { content: 'saved despite lost acknowledgement', type: 'text', clientMsgId: randomUUID() };
		dropDownstream = true;
		first.send(JSON.stringify(original));
		// Observe persistence directly while the proxy drops all backend response bytes.
		await new Promise(async (resolve, reject) => {
			const end = Date.now() + 8000;
			try {
				while (Date.now() < end) {
					const response = await fetch(`http://127.0.0.1:${backendPort}/api/chat/v1/message/history?room=${room}&type=private`, { headers: { Authorization: `Bearer ${a.token}` }, signal: AbortSignal.timeout(3000) });
					if ((await response.json()).data.messages.some(m => m.client_msg_id === original.clientMsgId)) { resolve(); return; }
					await new Promise(done => setTimeout(done, 50));
				}
				reject(new Error('message was not persisted'));
			} catch (error) { reject(error); }
		});
		for (const socket of connections) socket.destroy(); first.terminate(); dropDownstream = false;
		const retry = await connect(a);
		let ack = waitFrame(retry, frame => frame.name === 'ack' && frame.client_msg_id === original.clientMsgId);
		retry.send(JSON.stringify(original)); const saved = await ack;
		ack = waitFrame(retry, frame => frame.name === 'ack' && frame.client_msg_id === original.clientMsgId);
		retry.send(JSON.stringify(original)); assert.equal((await ack).id, saved.id);
		await stop(); await start();
		const history = await http(`message/history?room=${room}&type=private&afterSeq=0`, undefined, b.token, 'GET');
		assert.equal(history.messages.filter(m => m.client_msg_id === original.clientMsgId).length, 1);
		assert.equal(history.messages.find(m => m.id === saved.id).content, original.content);
		console.log('[network-faults] 60ms per TCP relay, downstream loss, reconnect/replay, database persistence and compiled backend restart passed; localhost fault injection, not public WAN');
	} finally {
		for (const ws of clients) ws.terminate();
		for (const socket of connections) socket.destroy();
		await new Promise(resolve => proxy.close(resolve));
		await stop();
	}
});

function waitFrame(ws, predicate) {
	return new Promise((resolve, reject) => {
		const cleanup = () => { clearTimeout(timer); ws.off('message', message); ws.off('close', close); ws.off('error', close); };
		const close = () => { cleanup(); reject(new Error('socket closed before expected frame')); };
		const message = raw => { const frame = JSON.parse(String(raw)); if (predicate(frame)) { cleanup(); resolve(frame); } };
		const timer = setTimeout(() => { cleanup(); reject(new Error('frame timeout')); }, 10000);
		ws.on('message', message); ws.once('close', close); ws.once('error', close);
	});
}
