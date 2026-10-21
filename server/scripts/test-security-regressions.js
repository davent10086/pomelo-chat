/** Compatibility entry; canonical test: tests/unit/identity/security-boundaries.test.cjs. */
if (require.main === module) {
  require("../../tests/run.cjs").main(["unit","--filter","security-boundaries.test.cjs"]).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
} else module.exports = require("../../tests/unit/identity/security-boundaries.test.cjs");
