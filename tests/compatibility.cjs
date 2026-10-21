/** Legacy aliases only; new tests are discovered from canonical directories. */
module.exports = {
  "server/scripts/test-agent-routing.js": {
    "layer": "unit",
    "filter": "agent-routing.test.cjs",
    "canonical": "tests/unit/assistant/agent-routing.test.cjs"
  },
  "server/scripts/test-agent-stream.js": {
    "layer": "unit",
    "filter": "agent-stream.test.cjs",
    "canonical": "tests/unit/assistant/agent-stream.test.cjs"
  },
  "server/scripts/test-p2-regressions.js": {
    "layer": "unit",
    "filter": "transaction-lifecycle.test.cjs",
    "canonical": "tests/unit/infrastructure/transaction-lifecycle.test.cjs"
  },
  "server/scripts/test-mcp-policy.js": {
    "layer": "unit",
    "filter": "mcp-policy.test.cjs",
    "canonical": "tests/unit/assistant/mcp-policy.test.cjs"
  },
  "server/scripts/test-security-regressions.js": {
    "layer": "unit",
    "filter": "security-boundaries.test.cjs",
    "canonical": "tests/unit/identity/security-boundaries.test.cjs"
  },
  "qa/unit-agent-logic.test.js": {
    "layer": "unit",
    "filter": "agent-logic.test.cjs",
    "canonical": "tests/unit/assistant/agent-logic.test.cjs"
  },
  "tests/database/test-database-target.test.js": {
    "layer": "unit",
    "filter": "test-database-target.test.js",
    "canonical": "tests/unit/infrastructure/test-database-target.test.js"
  },
  "server/scripts/test-agent-actions.js": {
    "layer": "integration",
    "filter": "actions.test.cjs",
    "canonical": "tests/integration/assistant/actions.test.cjs"
  },
  "server/scripts/test-agent-read-tools.js": {
    "layer": "integration",
    "filter": "read-tools.test.cjs",
    "canonical": "tests/integration/assistant/read-tools.test.cjs"
  },
  "server/scripts/test-tool-contracts.js": {
    "layer": "integration",
    "filter": "tool-contracts.test.cjs",
    "canonical": "tests/integration/assistant/tool-contracts.test.cjs"
  },
  "server/scripts/test-mcp-stdio.js": {
    "layer": "integration",
    "filter": "mcp-stdio.test.cjs",
    "canonical": "tests/integration/assistant/mcp-stdio.test.cjs"
  },
  "server/scripts/test-http-errors.js": {
    "layer": "integration",
    "filter": "errors.test.cjs",
    "canonical": "tests/integration/http/errors.test.cjs"
  },
  "server/scripts/test-backend-reliability.js": {
    "layer": "integration",
    "filter": "backend-reliability.test.cjs",
    "canonical": "tests/integration/messaging/backend-reliability.test.cjs"
  },
  "server/scripts/test-message-overload.js": {
    "layer": "integration",
    "filter": "overload.test.cjs",
    "canonical": "tests/integration/messaging/overload.test.cjs"
  },
  "server/scripts/test-system-integrity.js": {
    "layer": "integration",
    "filter": "system-integrity.test.cjs",
    "canonical": "tests/integration/messaging/system-integrity.test.cjs"
  },
  "server/scripts/test-db-migrations.js": {
    "layer": "integration",
    "filter": "migrations.test.cjs",
    "canonical": "tests/integration/database/migrations.test.cjs"
  },
  "server/scripts/test-prisma.js": {
    "layer": "integration",
    "filter": "prisma.test.cjs",
    "canonical": "tests/integration/database/prisma.test.cjs"
  },
  "server/scripts/test-production-smoke.js": {
    "layer": "integration",
    "filter": "production-smoke.test.cjs",
    "canonical": "tests/integration/http/production-smoke.test.cjs"
  },
  "server/scripts/test-report-regressions.js": {
    "layer": "integration",
    "filter": "reported-defects.test.cjs",
    "canonical": "tests/integration/regressions/reported-defects.test.cjs"
  },
  "server/scripts/test-architecture.js": {
    "layer": "checks",
    "filter": "architecture.check.cjs",
    "canonical": "tests/checks/architecture.check.cjs"
  },
  "server/scripts/test-message-protocol.js": {
    "layer": "checks",
    "filter": "message-protocol.check.cjs",
    "canonical": "tests/checks/message-protocol.check.cjs"
  }
};
