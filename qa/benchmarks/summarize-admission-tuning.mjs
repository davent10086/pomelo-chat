import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const inputs = process.argv.slice(2);
if (!inputs.length) throw Error('Provide calibration report.json paths');
const output = path.resolve('test-results', `admission-tuning-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
const rows = [], reports = [];
for (const input of inputs) {
  const file = path.resolve(input), report = JSON.parse(await readFile(file));
  reports.push({ path: file, started: report.started, seconds: report.secondsPerPhase,
    cpu: report.cpu, memoryGiB: report.memoryGiB, outboxSha256: report.outboxSha256 });
  for (const trial of report.trials) for (const phase of trial.phases) rows.push({
    source: file, profile: trial.name, instances: trial.topology.instances.length,
    settings: trial.settings, scenario: phase.name, seconds: phase.sendSeconds,
    attempted: phase.attempted, accepted: phase.accepted, received: phase.received, rejected: phase.rejected,
    acceptedPerSecond: phase.burst ? null : phase.accepted / phase.sendSeconds,
    ackP95Ms: phase.ackP95Ms, privateP95Ms: phase.privateP95Ms, groupP95Ms: phase.groupP95Ms,
    deliveryP99Ms: phase.deliveryP99Ms, drainMs: Math.max(phase.outboxDrainMs, phase.receiptDrainMs),
    peakPending: Math.max(0, ...phase.samples.map(sample => sample.pending)),
    oldestSeconds: Math.max(0, ...phase.samples.map(sample => sample.oldestSeconds)),
    rejectionCountersInstance0: phase.rejectionCounters,
    errors: phase.errors, samplingErrors: phase.samplingErrors,
    integrityPassed: phase.integrityPassed, meetsLatencyTargets: phase.meetsLatencyTargets,
    audit: phase.audit, crossInstancePrivatePairs: trial.topology.crossInstancePrivatePairs,
    backendErrors: trial.messageErrorTypes
  });
}
const f = value => value == null ? '—' : Number(value).toFixed(2);
const lines = [ '# 消息令牌桶额度实测', '',
  `CPU：${reports[0].cpu}；内存 ${f(reports[0].memoryGiB)} GiB。`, '',
  '所有服务、数据库、Redis、压测客户端均运行在同一台 Windows 机器，回环网络；结论限于当前负载和测试时长。300 个聊天连接，100 个私聊房间、两个各 50 人群。双实例私聊两端固定到不同进程。', '',
  '每行是一次试验的一个场景；百分位不跨轮合并。吞吐为接受数除以实际发送阶段时长，可能包含开始时的突发令牌。热点群延迟等待全部 50 个客户端。保护拒绝单独列示；瞬发不计算稳态吞吐。', '',
  '| 实例 | 配置 | 场景 | 时长 s | 接受/拒绝 | 吞吐 条/s | ACK P95 ms | 私聊 P95 ms | 群全员 P95 ms | 接收 P99 ms | 积压峰值 | 完整性 | 延迟目标 |',
  '|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|',
  ...rows.map(row => `| ${row.instances} | ${row.profile} | ${row.scenario} | ${f(row.seconds)} | ${row.accepted}/${row.rejected} | ${f(row.acceptedPerSecond)} | ${f(row.ackP95Ms)} | ${f(row.privateP95Ms)} | ${f(row.groupP95Ms)} | ${f(row.deliveryP99Ms)} | ${row.peakPending} | ${row.integrityPassed ? '通过' : '失败'} | ${row.meetsLatencyTargets ? '通过' : '失败'} |`), '',
  '延迟目标：私聊 P95 ≤500 ms，群全员 P95 ≤1000 ms，排空 ≤5 秒。即使全部通过，也不表示生产容量已得到认证。', '',
  '## 配置与证据', '',
  ...[...new Map(rows.map(row => [row.profile, row.settings]))].map(([name, settings]) => `- ${name}：${JSON.stringify(settings)}`), '',
  ...reports.map(report => `- ${report.path}；开始 UTC ${report.started}；每场景 ${report.seconds} 秒。`), '',
  '采样与保护原因计数仅来自实例 0，不能当作双实例总计；接受/拒绝数来自所有客户端。周期采样可能漏掉短暂积压峰值。没有测试数小时持续运行、跨物理机、真实公网、大群或数据库/Redis故障。当前结果不能确定全局最优参数。', ''
];
await writeFile(path.join(output, 'report.json'), JSON.stringify({ reports, rows }, null, 2));
await writeFile(path.join(output, 'REPORT.md'), lines.join('\n'));
console.log(output);
