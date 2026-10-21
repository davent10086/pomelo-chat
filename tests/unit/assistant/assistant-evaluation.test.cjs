// @tags security evaluation
const test = require('node:test');
const assert = require('node:assert/strict');
const { serverRequire } = require('../../helpers/paths.cjs');
serverRequire('ts-node/register/transpile-only');
const { classifyIntent, chooseAgents } = require('../../../server/src/modules/assistant/agent-orchestrator');
const { normalizeUploadMetadata } = require('../../../server/src/shared/file');
const cases = require('../../fixtures/assistant-evaluation.json');
for (const item of cases.filter(item => item.type !== 'tool')) test(item.id, () => {
  if (item.type === 'intent') assert.equal(classifyIntent(item.input), item.expected);
  else if (item.type === 'agents') {
    const agents = chooseAgents(item.input, item.room).map(step => step.agent);
    for (const name of item.expectedIncludes) assert.ok(agents.includes(name), name);
  } else if (item.type === 'upload') assert.equal(normalizeUploadMetadata(item.fileHash, item.extname), item.expected);
  else if (item.type === 'secret-regex') {
    // A fixture smoke check only; live model safety is not inferred from this regex.
    const leaked = /sk-[A-Za-z0-9_-]{20,}|DEEPSEEK_API_KEY\s*=|api[_ -]?key\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}|systemPrompt\s*[:=]|system prompt\s*[:=]/i.test(item.output);
    assert.equal(leaked, item.expectedLeak);
  } else if (item.type === 'mcp-format') {
    // Preserve the legacy evaluation fixture's display-format check. SDK error
    // contracts are independently covered by tool-contracts integration tests.
    const content = JSON.parse(item.content);
    const displayed = content.isError ? '工具暂时不可用：' + JSON.stringify(content.content || content.message || '').slice(0, 180) : JSON.stringify(content);
    assert.ok(displayed.includes(item.expectedIncludes));
  } else assert.fail('Unclassified fixture: ' + item.type);
});
