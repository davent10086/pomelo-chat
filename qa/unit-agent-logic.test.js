if (require.main === module) require('../tests/run.cjs').main(['unit', '--filter', 'agent-logic.test.cjs']).then(code => { process.exitCode = code; });
else /** Compatibility path. Canonical test: tests/unit/assistant/agent-logic.test.cjs. */
module.exports = require("../tests/unit/assistant/agent-logic.test.cjs");
