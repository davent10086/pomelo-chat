#!/usr/bin/env node
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const port = process.env.PORT || 3000;
const apiBase = process.env.AGENT_TEST_API_BASE || `http://localhost:${port}/api/chat/v1`;
const testRunId = Date.now();
const username = process.env.AGENT_TEST_USERNAME || `agent_test_${testRunId}`;
const password = process.env.AGENT_TEST_PASSWORD || '123456';
const phone = process.env.AGENT_TEST_PHONE || `139${String(testRunId).slice(-8)}`;
const input =
	process.argv.slice(2).join(' ') ||
	process.env.AGENT_TEST_INPUT ||
	'请用一句话介绍你作为聊天 Agent 能做什么，并给我三条回复建议';

const requestJson = async (url, options = {}) => {
	const resp = await fetch(url, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...(options.headers || {})
		}
	});
	const text = await resp.text();
	let body;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: resp.status, body };
};

const post = (pathName, data, token) =>
	requestJson(`${apiBase}${pathName}`, {
		method: 'POST',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined,
		body: JSON.stringify(data)
	});

const get = (pathName, token) =>
	requestJson(`${apiBase}${pathName}`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});

const assertBusinessSuccess = (label, result) => {
	if (result.status !== 200 || !result.body || result.body.code !== 200) {
		throw new Error(`${label} failed: ${JSON.stringify(result.body)}`);
	}
	return result.body.data;
};

(async () => {
	console.log(`[agent-test] API: ${apiBase}`);
	console.log(`[agent-test] User: ${username}`);

	if (!process.env.DEEPSEEK_API_KEY) {
		throw new Error('DEEPSEEK_API_KEY is missing. Put it in server/.env first.');
	}

	const register = await post('/auth/register', {
		username,
		password,
		phone,
		avatar: ''
	});
	if (register.body?.code === 200) {
		console.log('[agent-test] Registered test user.');
	} else if (register.body?.code === 2003) {
		console.log('[agent-test] Test user already exists.');
	} else {
		throw new Error(`register failed: ${JSON.stringify(register.body)}`);
	}

	await post('/auth/logout', { username });

	const login = await post('/auth/login', { username, password });
	const loginData = assertBusinessSuccess('login', login);
	const token = loginData.token;
	console.log('[agent-test] Login OK.');

	const tools = await get('/assistant/agent/tools', token);
	const toolsData = assertBusinessSuccess('agent tools', tools);
	console.log('[agent-test] Tools:');
	console.log((toolsData.tools || []).map(item => item.name).join(', ') || '(empty)');

	const toolCall = await post(
		'/assistant/agent/tools/call',
		{
			name: 'suggest_replies',
			args: {
				text: input,
				count: 2
			}
		},
		token
	);
	const toolCallData = assertBusinessSuccess('agent tool call', toolCall);
	console.log('\n[agent-test] Direct tool call:');
	console.log(JSON.stringify(toolCallData, null, 2));

	const agent = await post(
		'/assistant/agent',
		{
			input,
			context: { currentChatType: 'assistant' }
		},
		token
	);
	const agentData = assertBusinessSuccess('agent', agent);

	console.log('\n[agent-test] Agent content:');
	console.log(agentData.content || '(empty)');

	console.log('\n[agent-test] Summary:');
	console.log(agentData.summary || '(empty)');

	console.log('\n[agent-test] Todos:');
	console.log(JSON.stringify(agentData.todos || [], null, 2));

	console.log('\n[agent-test] Reply suggestions:');
	console.log(JSON.stringify(agentData.replySuggestions || [], null, 2));

	console.log('\n[agent-test] Draft message:');
	console.log(agentData.draftMessage || '(empty)');

	console.log('\n[agent-test] Actions:');
	console.log(JSON.stringify(agentData.actions || [], null, 2));

	console.log('\n[agent-test] Tool trace:');
	console.log(JSON.stringify(agentData.toolTrace || [], null, 2));

	console.log('\n[agent-test] Agent trace:');
	console.log(JSON.stringify(agentData.agentTrace || [], null, 2));

	console.log('\n[agent-test] Agent steps:');
	console.log(JSON.stringify(agentData.agentSteps || [], null, 2));

	await post('/auth/logout', { username });
	console.log('\n[agent-test] Done.');
})().catch(err => {
	console.error(`[agent-test] ${err.message}`);
	process.exit(1);
});
