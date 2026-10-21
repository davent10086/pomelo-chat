if (require.main === module) require('../run.cjs').main(['unit', '--filter', 'test-database-target.test.js']).then(code => { process.exitCode = code; });
else /** Compatibility path. Canonical test: tests/unit/infrastructure/test-database-target.test.js. */
module.exports = require("../unit/infrastructure/test-database-target.test.js");
