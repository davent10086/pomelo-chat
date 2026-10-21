const fs = require('node:fs/promises');
const path = require('node:path');
const tapCounts = text => {
  const read = name => Number([...text.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))].at(-1)?.[1] || 0);
  return { total: read('tests'), passed: read('pass'), failed: read('fail'), skipped: read('skipped'), cancelled: read('cancelled') };
};
const summarize = suites => ({
  suites: suites.length,
  passed: suites.filter(item => item.status === 'passed').length,
  failed: suites.filter(item => ['failed', 'timedOut', 'interrupted'].includes(item.status)).length,
  skipped: suites.filter(item => item.status === 'skipped').length,
  cases: suites.reduce((sum, item) => ({ total: sum.total + (item.counts?.total || 0), passed: sum.passed + (item.counts?.passed || 0), failed: sum.failed + (item.counts?.failed || 0), skipped: sum.skipped + (item.counts?.skipped || 0) }), { total: 0, passed: 0, failed: 0, skipped: 0 }),
});
const writeReport = async report => {
  for (const suite of report.suites) if (suite.status === 'passed' && (suite.counts?.failed || suite.counts?.cancelled)) suite.status = 'failed';
  report.summary = summarize(report.suites);
  report.status = report.suites.some(item => item.status !== 'passed' || item.counts?.failed || item.counts?.cancelled) ? 'failed' : report.summary.cases.skipped ? 'partial' : 'passed';
  report.durationMs = Date.now() - Date.parse(report.startedAt);
  const output = path.join(report.artifacts, 'report.json');
  await fs.mkdir(report.artifacts, { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  return output;
};
module.exports = { tapCounts, summarize, writeReport };
