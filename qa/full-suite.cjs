/** Compatibility alias: the default server suite has one canonical definition. */
require('../tests/run.cjs').main(['server']).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
