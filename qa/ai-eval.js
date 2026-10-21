#!/usr/bin/env node
require('../tests/run.cjs').main(['security', '--filter', 'assistant-evaluation']).then(code => { process.exitCode = code; });
