/** Compatibility alias. Resource ownership lives in tests/helpers/environment.cjs. */
const { main } = require('../../tests/run.cjs');
const mode = process.argv[2] || 'system';
const extra = process.argv.slice(3);
const aliases = {
  all: ['server'], browser: [extra.some(value => value.includes('real-rtc')) ? 'rtc' : 'e2e'],
  regressions: ['integration', '--filter', 'reported-defects'], system: ['integration', '--filter', 'system-integrity'],
  backend: ['integration', '--filter', 'backend-reliability'], overload: ['integration', '--filter', 'overload'],
  migrations: ['integration', '--filter', 'migrations'], prisma: ['integration', '--filter', 'database/prisma'],
  desktop: ['desktop-production'], qa: ['qa'],
};
if (!aliases[mode]) throw new Error('Unknown legacy test mode: ' + mode);
const forwarded = mode === 'browser' ? extra.flatMap(value => value.endsWith('.spec.ts') ? ['--filter', require('node:path').basename(value)] : [value]) : extra;
main([...aliases[mode], ...forwarded]).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
