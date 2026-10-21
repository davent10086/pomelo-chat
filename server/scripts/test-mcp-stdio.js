/** Compatibility entry; canonical test: tests/integration/assistant/mcp-stdio.test.cjs. */
if (require.main === module) {
  require("../../tests/run.cjs").main(["integration","--filter","mcp-stdio.test.cjs"]).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
} else module.exports = require("../../tests/integration/assistant/mcp-stdio.test.cjs");
