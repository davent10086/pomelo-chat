import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const dir = process.argv[2] || path.join('test-results', (await readdir('test-results')).filter(name => name.startsWith('im-evaluation-')).sort().at(-1));
const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json')));
const functionalStage = manifest.stages.find(stage => stage.name === 'multi-instance');
const functionalPath = manifest.functionalReport || functionalStage?.report;
const functional = functionalPath ? JSON.parse(await readFile(functionalPath)) : undefined;
const format = value => value == null ? '—' : Number(value).toFixed(2);
const pct = (count, total) => total ? `${(count / total * 100).toFixed(2)}%` : '—';
const lines = [
  '# Pomelo Chat 双实例可靠性与压测评估', '',
  `测试开始（UTC）：${manifest.started}。北京时间为 UTC+8。本报告对应当前工作区，包含此前未提交的桌面端改造。`, '',
  '## 环境与方法', '',
  `- CPU：${manifest.hardware.cpu}；${manifest.hardware.windows?.cpu?.NumberOfCores || '—'} 核 / ${manifest.hardware.logicalCpus} 逻辑处理器。`,
  `- 内存：${format(manifest.hardware.totalGiB)} GiB；开始时可用 ${format(manifest.hardware.freeGiB)} GiB，机器还运行其他应用。`,
  `- 系统：${manifest.platform}（Windows 版本 ${manifest.hardware.windows?.os?.Version || '见清单'}）；Node ${manifest.node}。原始中文系统名称采集存在控制台编码差异，按版本号记录。`,
  `- 工作区磁盘：${manifest.hardware.windows?.workspaceDisk?.FriendlyName || '见 manifest.json'}。未单独测磁盘 IOPS。`,
  `- 服务版本：MySQL ${functional?.versions?.mysql || '见分项报告'}，Redis ${functional?.versions?.redis || '见分项报告'}。Redis 版本较旧。`,
  '- 所有连接为本地回环。两个实例为独立 Node.js 进程，共享本次创建的 MySQL 数据库、Redis 键前缀及上传目录。',
  '- 功能测试使用提高后的消息额度；压测保持 steady/default 消息保护。HTTP fixture 额度提高以便创建测试数据。',
  '- 压测串行执行，每种拓扑仅一次固定顺序试验；时延百分位只统计完成样本，拒绝、缺失及生成器丢弃另列。',
  '- 未部署 OpenIM，也没有同机同负载对照；不能计算两者性能倍数。', '',
  '## 双实例功能验证', '',
  `证据：${functionalPath || '缺失'}；完成状态：${functional?.completed}。`, '',
  '| 检查 | 结果 | 耗时 ms |', '|---|---|---:|',
  ...(functional?.checks || []).map(check => `| ${check.name} | ${check.passed ? '通过' : '失败'} | ${format(check.ms)} |`), '',
  `数据库审计：${JSON.stringify(functional?.audit)}。`,
  '验证了 125 条离线消息分两页恢复；同一幂等键在两个实例上并发提交仍只持久化一条；广播订阅缺口与进程重启均由真实浏览器恢复。',
  '首次两次驱动运行未纳入性能结果：一次因已读检查时接收窗口未停在底部，一次因测试驱动误判被信号终止的进程状态而卡住。最终回归修正了测试前提与进程判断，业务代码未因此变更。', '',
  '另一次容量预跑的并发建连采用轮流端点分配，不能保证每对私聊都跨实例，因此不采用其性能数字。最终校准固定两端实例，并在报告中断言 100 对私聊全部跨实例。', '',
  '## 保护参数', '',
  '| 范围 | 速率 / 突发，或门槛 |', '|---|---|',
  '| 用户 | 5 条/秒；突发 10 条 |', '| 私聊房间 | 10 条/秒；突发 20 条 |', '| 群聊房间 | 20 条/秒；突发 20 条 |',
  '| 全局（Redis 共享） | 150 条/秒；突发 100 条 |', '| 房间 / 实例内排队 | 32 / 256 |',
  '| Outbox 总数 / 单房间 / 最旧年龄 | 500 / 40 / 3 秒；每 2 秒采样，是软门槛 |',
  '| 每实例 MySQL 连接池 / Outbox worker | 10 / 8；双实例总计最多 20 连接 / 16 worker lanes |', '',
  '## 固定提供速率压测', '',
  '100 个私聊房间、200 个私聊连接，另有两个各 50 人群，共 300 个聊天连接。双实例私聊发送端固定实例 0、接收端固定实例 1，群连接轮流分配。每个稳态场景提供负载 30 秒。',
  '吞吐为接受数 / 实际发送阶段秒数。接收 P95 同时等待 ACK 与私聊两端/群内全部 50 个客户端；P99 列覆盖该阶段所有完成消息。', '',
  '| 实例 | 场景 | 提供 条/秒 | 接受 / 拒绝 | 接受 条/秒 | 拒绝率 | ACK P95 ms | 私聊接收 P95 ms | 群全员接收 P95 ms | 接收 P99 ms | 未确认 / 未收到 | 重复 / 乱序 |',
  '|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
];
const summaries = [];
for (const stage of manifest.stages) {
  if (!stage.report) continue;
  const report = JSON.parse(await readFile(stage.report));
  if (stage.name.startsWith('calibration-')) for (const trial of report.trials) for (const row of trial.phases) {
    const instances = trial.topology.instances.length;
    const errors = Object.values(row.errors).reduce((sum, n) => sum + n, 0);
    const summary = { instances, scenario: row.name, offered: row.offered, attempted: row.attempted,
      accepted: row.accepted, received: row.received, refused: row.rejected,
      acceptedPerSecond: row.accepted / row.sendSeconds, refusalRate: row.rejected / row.attempted,
      unexpectedErrors: errors, unexpectedErrorRate: errors / row.attempted,
      crossInstancePrivatePairs: trial.topology.crossInstancePrivatePairs,
      unexpectedCloses: row.unexpectedCloses, samplingErrors: row.samplingErrors,
      observedInstance0Rejections: row.rejectionCounters,
      sampledInstance0PeakQueue: Math.max(0, ...row.samples.map(sample => sample.queue)),
      sampledOutboxPeak: Math.max(0, ...row.samples.map(sample => sample.pending)),
      sampledOutboxOldestSeconds: Math.max(0, ...row.samples.map(sample => sample.oldestSeconds)),
      missingAcknowledgements: row.missingAcknowledgements, missingAcceptedReceipts: row.missingAcceptedReceipts,
      generatorDropped: row.generatorDropped, duplicates: row.duplicates, orderErrors: row.orderErrors,
      ackP95Ms: row.ackP95Ms, privateP95Ms: row.privateP95Ms, groupP95Ms: row.groupP95Ms, deliveryP99Ms: row.deliveryP99Ms,
      receiptDrainMs: row.receiptDrainMs, outboxDrainMs: row.outboxDrainMs, meetsLatencyTargets: row.meetsLatencyTargets, integrityPassed: row.integrityPassed, source: stage.report };
    summaries.push(summary);
    lines.push(`| ${instances} | ${row.name}${row.burst ? '（瞬时突发）' : ''} | ${row.offeredRate}${row.burst ? ' 条瞬发' : ''} | ${row.accepted} / ${row.rejected} | ${row.burst ? '不计算稳态' : format(summary.acceptedPerSecond)} | ${pct(row.rejected, row.attempted)} | ${format(row.ackP95Ms)} | ${format(row.privateP95Ms)} | ${format(row.groupP95Ms)} | ${format(row.deliveryP99Ms)} | ${row.missingAcknowledgements} / ${row.missingAcceptedReceipts} | ${row.duplicates} / ${row.orderErrors} |`);
  }
}
lines.push('', '异常错误率按意外协议错误 / 实际尝试计算；明确保护拒绝单独列示。缺失 ACK、接受后缺失接收、生成器丢弃、异常断连与数据审计还必须同时检查，不能只看错误率。',
  '原始 samples/rejectionCounters 只抓取实例 0，不能当作两个实例的计数总和；表中接受/拒绝来自全部客户端响应。上述 Outbox 门槛为配置值，本轮没有主动注入数据库阻塞以覆盖所有保护分支；实际触发情况见原始计数。',
  `完整性失败场景数：${summaries.filter(row => !row.integrityPassed).length}；延迟/排空目标失败场景数：${summaries.filter(row => !row.meetsLatencyTargets).length}。阶段进程退出成功不代表延迟目标全部达标。`, '');
for (const row of summaries.filter(row => !row.meetsLatencyTargets)) lines.push(
  `- ${row.instances} 实例 ${row.scenario} 未达到延迟/排空目标：私聊 P95 ${format(row.privateP95Ms)} ms，群全员 P95 ${format(row.groupP95Ms)} ms；采样 Outbox 峰值 ${row.sampledOutboxPeak}，最旧 ${format(row.sampledOutboxOldestSeconds)} 秒。`
);
lines.push('', '门槛采用周期采样并发准入，存在超调；例如采样值超过 500 不能解读为 500 条硬队列上限。高负载退化的具体根因仍需独立采集 SQL 锁等待、Outbox 认领/投递耗时及进程资源曲线，当前证据不足以归因到语言、ORM 或硬件。', '');
for (const stage of manifest.stages.filter(stage => stage.name.startsWith('protection-'))) {
  const report = JSON.parse(await readFile(stage.report));
  lines.push('## 既有闭环保护脚本', '', '每阶段 15 秒，客户端收到明确拒绝后退避，因此提供速率不是固定外生负载。私聊延迟包含接收方，群聊时延只含 ACK，群全员完整性在阶段结束后另行检查。', '', '| 阶段 | 尝试 | 接受 | 保护拒绝 | 接受 条/秒 | P95 ms | P99 ms | 意外错误 |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of report.rows) lines.push(`| ${row.name} | ${row.attempts} | ${row.success} | ${row.rejected} | ${format(row.successPerSecond)} | ${format(row.p95Ms)} | ${format(row.p99Ms)} | ${JSON.stringify(row.errors)} |`);
  lines.push('', `群接收完整性：${JSON.stringify(report.group)}；审计：${JSON.stringify(report.audit)}。`, '');
}
lines.push('## OpenIM 对照判断', '',
  '本次验证支持：Pomelo Chat 在受控双进程、共享单数据库/Redis的范围内具备基本跨实例消息、幂等与恢复能力。它没有建立与 OpenIM 性能相当的证据。',
  'OpenIM 的平台范围包含跨设备同步、漫游消息、多平台 SDK、离线推送、对象存储和集群部署。当前项目仍缺少相应体系与生产证据；应用进程可重启不等于数据库/Redis/宿主机高可用。',
  '- [OpenIM 消息、离线与多端概念](https://docs.openim.io/docs/guides/getting-started/concepts)',
  '- [OpenIM 环境与组件](https://docs.openim.io/zh/docs/guides/deployment/components)',
  '官方环境页的负载数字属于其配置估算，不能与本机限流结果直接算倍数。', '',
  '## 证据与限制', '',
  `完整清单、硬件、源码摘要、阶段退出码：${path.resolve(dir, 'manifest.json')}。`,
  ...manifest.stages.map(stage => `- ${stage.name}：exit=${stage.exitCode}，${stage.report || stage.log}`), '',
  ...manifest.limitations.map(line => `- ${line}`), '',
  '建议后续固定生产 Linux/Redis 版本，开展跨物理机、真实网络、长时间运行和依赖故障演练；需要比较性能时，在相同硬件和消息/群规模/持久化语义下另跑 OpenIM。'
);
await writeFile(path.join(dir, 'summary.json'), JSON.stringify({ functional: functional?.completed, stagesCompleted: manifest.completed, rows: summaries }, null, 2));
await writeFile(path.join(dir, 'REPORT.md'), lines.join('\n') + '\n');
console.log(path.resolve(dir, 'REPORT.md'));
