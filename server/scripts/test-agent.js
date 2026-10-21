/** Compatibility alias; the online model suite is opt-in. */
require('../../tests/run.cjs').main(['ai-live']).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
