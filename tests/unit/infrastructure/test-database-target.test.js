const { serverRequire, serverRoot: testServerRoot, repoRoot: testRepoRoot } = require("../../helpers/paths.cjs");
process.env.TS_NODE_PROJECT = require('node:path').join(process.cwd(), 'server', 'tsconfig.json');
require("../../../server/node_modules/ts-node/register/transpile-only");

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertTestDatabaseTarget } = require("../../../server/src/infrastructure/database");

test('database test guard rejects production-like targets and accepts explicit test targets', () => {
	assert.throws(() => assertTestDatabaseTarget('pomelo-chat'), /test database/i);
	assert.throws(() => assertTestDatabaseTarget('pomelo-production'), /test database/i);
	assert.doesNotThrow(() => assertTestDatabaseTarget('pomelo_chat_test'));
	assert.doesNotThrow(() => assertTestDatabaseTarget('test_pomelo_chat'));
});
