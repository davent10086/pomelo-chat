#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');

process.chdir(path.join(__dirname, '..', 'server'));
process.env.TS_NODE_PROJECT = path.join(process.cwd(), 'tsconfig.json');
require('../server/node_modules/dotenv').config({ path: path.join(process.cwd(), '.env') });
require('../server/node_modules/ts-node/register/transpile-only');

const { classifyIntent, chooseAgents } = require('../server/src/service/assistant/agent-orchestrator');
const { executePomeloTool } = require('../server/src/service/assistant/tools/pomelo-tools');
const { normalizeUploadMetadata } = require('../server/src/utils/file');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'ai-eval-cases.json'), 'utf8'));
const secretLeakRegex = /sk-[A-Za-z0-9_-]{20,}|DEEPSEEK_API_KEY\s*=|api[_ -]?key\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}|systemPrompt\s*[:=]|system prompt\s*[:=]/i;

const getPath = (value, key) => key.split('.').reduce((cur, part) => cur?.[part], value);

const normalizeMcpError = content => {
  let parsed = content;
  try {
    parsed = JSON.parse(content);
  } catch {
    return String(content);
  }
  if (parsed?.isError) return '工具暂时不可用：' + JSON.stringify(parsed.content || parsed.message || '').slice(0, 180);
  return JSON.stringify(parsed);
};

(async () => {
  const results = [];
  for (const item of cases) {
    try {
      let pass = false;
      let actual;
      if (item.type === 'intent') {
        actual = classifyIntent(item.input);
        pass = actual === item.expected;
      } else if (item.type === 'agents') {
        actual = chooseAgents(item.input, item.room).map(step => step.agent);
        pass = item.expectedIncludes.every(name => actual.includes(name));
      } else if (item.type === 'tool') {
        actual = await executePomeloTool({ userId: Number(process.env.POMELO_MCP_USER_ID || 1) }, {
          name: item.tool,
          args: item.args
        });
        const selected = getPath(actual, item.expectedPath);
        pass = Array.isArray(selected) && selected.length >= item.minLength;
      } else if (item.type === 'upload') {
        actual = normalizeUploadMetadata(item.fileHash, item.extname);
        pass = actual === item.expected;
      } else if (item.type === 'secret-regex') {
        actual = secretLeakRegex.test(item.output);
        pass = actual === item.expectedLeak;
      } else if (item.type === 'mcp-format') {
        actual = normalizeMcpError(item.content);
        pass = actual.includes(item.expectedIncludes);
      }
      results.push({ id: item.id, pass, actual });
      console.log(`[${pass ? 'PASS' : 'FAIL'}] ${item.id}`);
    } catch (error) {
      results.push({ id: item.id, pass: false, error: error.message });
      console.log(`[FAIL] ${item.id} - ${error.message}`);
    }
  }

  const summary = {
    pass: results.filter(item => item.pass).length,
    fail: results.filter(item => !item.pass).length,
    total: results.length
  };
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `ai-eval-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));
  console.log(`\nAI eval summary: ${summary.pass}/${summary.total} passed`);
  console.log(`Wrote ${outPath}`);
  process.exit(summary.fail ? 1 : 0);
})();
