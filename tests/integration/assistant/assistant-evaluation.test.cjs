// @tags security evaluation
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { serverRequire } = require('../../helpers/paths.cjs');
serverRequire('ts-node/register/transpile-only');
const { executePomeloTool } = require('../../../server/src/modules/assistant/tools/pomelo-tools');
const { better_chat } = require('../../../server/src/infrastructure/redis');
after(() => better_chat.disconnect());
for (const item of require('../../fixtures/assistant-evaluation.json').filter(item => item.type === 'tool')) test(item.id, async () => {
  // These text-only tools need no persisted user; their rate-limit state is isolated in Redis.
  const result = await executePomeloTool({ userId: 987654321 }, { name: item.tool, args: item.args });
  const selected = item.expectedPath.split('.').reduce((value, key) => value?.[key], result);
  assert.ok(Array.isArray(selected) && selected.length >= item.minLength);
});
