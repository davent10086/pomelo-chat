import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
const root = process.cwd(), exec = promisify(execFile);
const output = path.resolve('test-results', `im-evaluation-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
const report = { started: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.release()}`,
  hardware: { cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, totalGiB: os.totalmem() / 2 ** 30, freeGiB: os.freemem() / 2 ** 30 },
  sourceSha256: {}, stages: [], limitations: [
    'All backends, clients, generators and dependencies share this Windows host or its local service environment; loopback traffic, no WAN latency.',
    'Single fixed-order trial per topology. Successful-operation percentiles exclude refusals, which are separately reported. Not a maximum-capacity search.',
    'Functional checks raise message budgets; calibration/protection phases use documented steady/default budgets. No real model or media calls.',
    'No OpenIM deployment or same-hardware OpenIM benchmark is run; no throughput equivalence or percentage claim is supported.'
  ] };
for (const name of ['server/src/modules/messaging/outbox.ts', 'server/src/modules/realtime/message-delivery.ts', 'qa/benchmarks/calibrate-admission.mjs', 'qa/benchmarks/chat-backend.mjs'])
  report.sourceSha256[name] = createHash('sha256').update(await readFile(name)).digest('hex');
if (process.platform === 'win32') {
  const command = "$benchmarkCPU=Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors; $benchmarkOS=Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,TotalVisibleMemorySize,FreePhysicalMemory; $benchmarkDisk=Get-Partition -DriveLetter F | Get-Disk | Select-Object FriendlyName,BusType,Size; [pscustomobject]@{cpu=$benchmarkCPU;os=$benchmarkOS;workspaceDisk=$benchmarkDisk} | ConvertTo-Json -Depth 5";
  try { report.hardware.windows = JSON.parse((await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true })).stdout); }
  catch (error) { report.hardware.queryError = error.message; }
}
const save = () => writeFile(path.join(output, 'manifest.json'), JSON.stringify(report, null, 2));
async function stage(name, script, extraEnv = {}) {
  const record = { name, script, started: new Date().toISOString(), freeGiB: os.freemem() / 2 ** 30, settings: extraEnv };
  report.stages.push(record); await save(); console.log(`START ${name}`);
  const env = { ...process.env, ...extraEnv };
  delete env.BENCH_DIAGNOSTIC_PRELOAD;
  const child = spawn(process.execPath, [script], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { log += chunk; process.stderr.write(chunk); });
  record.pid = child.pid;
  record.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  record.ended = new Date().toISOString(); record.log = path.join(output, `${name}.log`);
  await writeFile(record.log, log);
  const matches = [...log.matchAll(/Report: (.+)/g)];
  if (matches.length) record.report = path.join(matches.at(-1)[1].trim(), 'report.json');
  await save(); console.log(`END ${name} exit=${record.exitCode}`);
}
try {
  if (process.argv.includes('--benchmarks-only')) {
    const names = (await readdir('test-results')).filter(name => name.startsWith('multi-instance-')).sort();
    const file = path.resolve('test-results', names.at(-1), 'report.json');
    const functional = JSON.parse(await readFile(file));
    if (!functional.completed) throw new Error('Most recent multi-instance check has not passed');
    report.functionalReport = file;
  } else {
    await stage('multi-instance', 'qa/benchmarks/multi-instance.mjs');
    if (report.stages.at(-1).exitCode) throw new Error('Multi-instance functional validation failed');
  }
  for (const count of [1, 2]) await stage(`calibration-${count}-instance`, 'qa/benchmarks/calibrate-admission.mjs', {
    BENCH_INSTANCES: String(count), CALIBRATION_PROFILES: 'steady', CALIBRATION_SECONDS: '30',
    CALIBRATION_PHASES: 'normal,private-load,hot-group,mixed,global-burst'
  });
  await stage('protection-2-instance', 'qa/benchmarks/message-protection.mjs', { BENCH_INSTANCES: '2' });
  report.completed = report.stages.every(stage => stage.exitCode === 0);
  if (!report.completed) process.exitCode = 1;
} catch (error) { report.completed = false; report.error = error.stack; console.error(error); process.exitCode = 1; }
finally { report.ended = new Date().toISOString(); await save(); console.log(`Evaluation: ${output}`); }
