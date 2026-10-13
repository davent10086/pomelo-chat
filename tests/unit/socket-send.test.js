process.env.TS_NODE_PROJECT = require('node:path').join(process.cwd(), 'server', 'tsconfig.json');
require('../../server/node_modules/ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const test = require('node:test');
const { sendSocketFrame } = require('../../server/src/utils/socket-send');
const { forEachConcurrent } = require('../../server/src/utils/parallel');

test('slow socket is terminated before buffering more data; healthy socket receives frame', () => {
	let sent = 0, terminated = 0;
	const ws = { readyState: 1, bufferedAmount: 1024 * 1024, terminate: () => terminated++, send: () => sent++ };
	sendSocketFrame(ws, { content: 'hello' });
	assert.equal(terminated, 1);
	assert.equal(sent, 0);
	ws.bufferedAmount = 0;
	ws.send = (raw, callback) => { sent++; assert.equal(JSON.parse(raw).content, 'hello'); callback(); };
	sendSocketFrame(ws, { content: 'hello' });
	assert.equal(sent, 1);
	ws.readyState = 3;
	sendSocketFrame(ws, { content: 'hello' });
	assert.equal(sent, 1);
});

test('bounded fanout waits for all recipients even if one fails', async () => {
	let active = 0, maximum = 0;
	const completed = [];
	await assert.rejects(forEachConcurrent([1, 2, 3, 4, 5], 2, async value => {
		maximum = Math.max(maximum, ++active);
		await new Promise(resolve => setImmediate(resolve));
		active--;
		completed.push(value);
		if (value === 2) throw new Error('recipient failed');
	}), /recipient failed/);
	assert.equal(maximum, 2);
	assert.equal(active, 0);
	assert.deepEqual(completed.sort(), [1, 2, 3, 4, 5]);
});
