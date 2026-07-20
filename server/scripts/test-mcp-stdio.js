#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');

const serverDir = path.join(__dirname, '..');
const userId = process.env.POMELO_MCP_USER_ID || process.env.AGENT_TEST_USER_ID || '1';
const childEnv = Object.fromEntries(
	Object.entries({
		...process.env,
		POMELO_MCP_USER_ID: userId
	}).filter(([, value]) => value !== undefined)
);

const command = process.execPath;
const args = [path.join(serverDir, 'node_modules', 'ts-node', 'dist', 'bin.js'), '--files', 'src/mcp/pomelo-stdio.ts'];

const child = spawn(
	command,
	args,
	{
		cwd: serverDir,
		env: childEnv,
		stdio: ['pipe', 'pipe', 'pipe']
	}
);

let buffer = '';
const pending = new Map();

const send = (id, method, params) => {
	child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				reject(new Error(`${method} timed out`));
			}
		}, 10000);
	});
};

const notify = (method, params) => {
	child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
};

child.stdout.on('data', chunk => {
	buffer += chunk.toString('utf8');
	let index;
	while ((index = buffer.indexOf('\n')) >= 0) {
		const raw = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!raw) continue;
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			continue;
		}
		if (msg.id !== undefined && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) reject(new Error(JSON.stringify(msg.error)));
			else resolve(msg.result);
		}
	}
});

child.stderr.on('data', chunk => {
	process.stderr.write(chunk);
});

child.on('exit', code => {
	if (code && pending.size > 0) {
		for (const { reject } of pending.values()) {
			reject(new Error(`mcp server exited with code ${code}`));
		}
		pending.clear();
	}
});

(async () => {
	try {
		console.log(`[mcp-test] User id: ${userId}`);
		const init = await send(1, 'initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: {
				name: 'pomelo-mcp-test',
				version: '1.0.0'
			}
		});
		console.log(`[mcp-test] Initialized: ${init.serverInfo?.name || 'unknown'}`);
		notify('notifications/initialized', {});

		const list = await send(2, 'tools/list', {});
		const tools = list.tools || [];
		console.log(`[mcp-test] Tools: ${tools.map(item => item.name).join(', ')}`);
		if (!tools.some(item => item.name === 'suggest_replies')) {
			throw new Error('suggest_replies tool is missing.');
		}

		const call = await send(3, 'tools/call', {
			name: 'suggest_replies',
			arguments: {
				text: '请帮我给同事一个礼貌回复：我会今天确认接口文档。',
				count: 2
			}
		});
		console.log('[mcp-test] Tool call result:');
		console.log(JSON.stringify(call.structuredContent || call.content, null, 2));
		child.kill('SIGTERM');
	} catch (err) {
		child.kill('SIGTERM');
		console.error(`[mcp-test] ${err.message}`);
		process.exit(1);
	}
})();
