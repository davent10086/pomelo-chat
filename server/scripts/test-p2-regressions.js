/** Compatibility entry; canonical test: tests/unit/infrastructure/transaction-lifecycle.test.cjs. */
if (require.main === module) {
  require("../../tests/run.cjs").main(["unit","--filter","transaction-lifecycle.test.cjs"]).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
} else module.exports = require("../../tests/unit/infrastructure/transaction-lifecycle.test.cjs");
