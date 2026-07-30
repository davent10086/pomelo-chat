const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const assertIncludes = (file, pattern, label) => {
	const text = read(file);
	const ok = pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
	if (!ok) {
		throw new Error(`${label} missing in ${file}`);
	}
};

assertIncludes('server/src/model/db.ts', 'client_msg_id VARCHAR(64)', 'client message id column');
assertIncludes('server/src/model/db.ts', 'room_seq BIGINT', 'room sequence column');
assertIncludes('server/src/model/db.ts', 'CREATE TABLE IF NOT EXISTS conversation', 'conversation table');
assertIncludes('server/src/model/db.ts', 'CREATE TABLE IF NOT EXISTS conversation_read', 'conversation read table');
assertIncludes('server/src/model/db.ts', 'CREATE TABLE IF NOT EXISTS mcp_audit_log', 'MCP audit table');
assertIncludes('server/src/model/db.ts', 'export const initDatabase', 'explicit migration entry');
assertIncludes('server/package.json', '"db:migrate"', 'db migration script');
assertIncludes('server/src/controller/routes/message.ts', "router.get('/history'", 'history route');
assertIncludes('server/src/controller/routes/message.ts', "router.post('/read'", 'read route');
assertIncludes('server/src/service/message/index.ts', 'MESSAGE_FANOUT_CHANNEL', 'redis fanout channel');
assertIncludes('server/src/service/message/index.ts', 'client_msg_id', 'idempotent message handling');
assertIncludes('server/src/service/message/index.ts', "name: 'ack'", 'server ack frame');
assertIncludes('client/src/pages/chat/useChatSocket.ts', "message.name === 'ack'", 'client ack handling');
assertIncludes('client/src/pages/chat/useChatSocket.ts', "ok: false", 'client failed send handling');
assertIncludes('client/src/pages/chat/index.tsx', 'markChatRead', 'frontend read cursor reporting');
assertIncludes('client/src/components/MessageShow/index.tsx', '发送失败', 'failed send indicator');
assertIncludes('server/src/utils/rate-limit.ts', 'createRateLimiter', 'generic API rate limiter');
assertIncludes('server/src/controller/app.ts', 'apiRateLimit', 'API rate limiter mounted');
assertIncludes('server/src/controller/app.ts', 'securityHeaders', 'security headers middleware');
assertIncludes('server/src/controller/app.ts', 'X-Content-Type-Options', 'content type sniffing protection');
assertIncludes('server/src/controller/app.ts', /app\.use\(securityHeaders\);\s*app\.use\('\/uploads'/, 'security headers applied before uploads');
assertIncludes('server/src/service/assistant/agent-prompts.ts', 'AGENT_PROMPT_VERSION', 'versioned agent prompt');
assertIncludes('server/src/service/assistant/agent.ts', 'promptVersion', 'agent prompt version returned');
assertIncludes('server/src/service/assistant/tools/external-mcp.ts', 'mcp_tool_call', 'MCP tool audit log');
assertIncludes('server/src/service/assistant/tools/external-mcp.ts', 'mcp_audit_log', 'MCP audit persistence');
assertIncludes('client/src/components/ChatContainer/index.tsx', 'visibleRange', 'virtualized chat visible range');
assertIncludes('client/src/components/ChatContainer/index.tsx', 'measuredHeights', 'dynamic row height cache');
assertIncludes('client/src/components/ChatContainer/index.tsx', 'topPlaceholderHeight', 'virtualized top spacer');
assertIncludes('client/src/components/ChatContainer/index.tsx', 'bottomPlaceholderHeight', 'virtualized bottom spacer');

console.log('[message-protocol] all assertions passed');
