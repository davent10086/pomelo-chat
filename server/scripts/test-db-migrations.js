/** Compatibility entry; canonical test: tests/integration/database/migrations.test.cjs. */
if (require.main === module) {
  require("../../tests/run.cjs").main(["integration","--filter","migrations.test.cjs"]).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
} else module.exports = require("../../tests/integration/database/migrations.test.cjs");
