/** Compatibility entry; canonical test: tests/checks/message-protocol.check.cjs. */
if (require.main === module) {
  require("../../tests/run.cjs").main(["checks","--filter","message-protocol.check.cjs"]).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
} else module.exports = require("../../tests/checks/message-protocol.check.cjs");
