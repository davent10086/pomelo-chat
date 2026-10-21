/** Compatibility entry; canonical test: tests/checks/architecture.check.cjs. */
if (require.main === module) {
  require("../../tests/run.cjs").main(["checks","--filter","architecture.check.cjs"]).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
} else module.exports = require("../../tests/checks/architecture.check.cjs");
