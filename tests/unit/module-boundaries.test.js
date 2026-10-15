const assert = require('node:assert/strict');
const test = require('node:test');
const {checkSources} = require('../../server/scripts/test-architecture');

test('all backend layers reject removed compatibility imports', () => {
	for (const file of ['controller/routes/assistant.ts', 'composition.ts', 'modules/assistant/agent.ts']) {
		assert.ok(checkSources({ [file]: "import { old } from '" + (file.includes('/') ? '../../service/assistant/agent' : './service/assistant/agent') + "';" }).some(error => error.includes('legacy import')));
	}
});

test('architecture check rejects internal imports, transport leakage and module cycles', () => {
	const errors = checkSources({
		'modules/social/application.ts': "import {save} from '../messaging/persistence'; import type {Request} from 'express';",
		'modules/messaging/application.ts': "import {authorize} from '../social/public';"
	});
	assert.ok(errors.some(error => error.includes('internal file')));
	assert.ok(errors.some(error => error.includes('transport dependency')));
	assert.ok(errors.some(error => error.includes('module cycle')));
});

test('architecture check accepts transaction contracts and public APIs but rejects foreign writes', () => {
	assert.deepEqual(checkSources({
		'modules/social/contracts.ts': "import type {Message} from '../messaging/contracts';",
		'modules/messaging/application.ts': "import {authorize} from '../social/public';"
	}), []);
	assert.ok(checkSources({'modules/assistant/repository.ts': "const sql = 'INSERT INTO message SET ?';"}).some(error => error.includes('writes table owned elsewhere')));
	assert.ok(checkSources({'read-models/query.ts': "const sql = 'DELETE FROM user WHERE id = ?';"}).some(error => error.includes('write in read model')));
});
