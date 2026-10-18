# 优化数据测试

在仓库根目录运行（需要现有 client 依赖、@playwright/test 与 Playwright Chromium）：

```powershell
node qa/benchmarks/first-screen.mjs
```

默认每组 7 次正式测试，另有一次预热；每次创建独立浏览器上下文、禁用缓存，并交替执行两组。
结果保存在 `test-results/first-screen/report.md` 与 `report.json`，包括每次的资源 URL、gzip 实际响应体字节数、解压字节数、FCP、LCP、截图、Git 状态和环境信息。

快速验证或增加样本数：

```powershell
$env:BENCH_RUNS = '2'
node qa/benchmarks/first-screen.mjs
Remove-Item Env:BENCH_RUNS
```

测试采用当前工作区构建两个版本：对照组将 `client/src/router/config.ts` 中的懒加载转换成静态导入，同时关闭 `manualChunks`；实验组保留当前配置。不修改源码、已有 dist 或数据库。临时构建位于系统临时目录，便于复查。

这是措施消融实验，不是历史版本对比。仅测未登录 `/login` 首屏，不代表登录后的聊天页；API/外部请求会被阻止，不调用实际服务。gzip JS 体积统计首次导航实际请求的全部 JS，包括公共分包，不以入口文件大小冒充总首屏体积。固定下载 200000 B/s、延迟 150 ms、CPU 4 倍减速；使用每组中位数计算 `(对照组 - 实验组) / 对照组 × 100%`，负数表示变慢或变大。

先检查截图、每次样本的最小/最大值与请求清单，再决定是否适合写进简历。速度结果受本机负载影响，不能当作生产环境结果；一次测试不能证明稳定提升。若结果不改善，应如实报告，不强行生成提升数字。

## 登录后的聊天首页

```powershell
$env:BENCH_SCENARIO = 'chat'
node qa/benchmarks/first-screen.mjs
Remove-Item Env:BENCH_SCENARIO
```

读取 `server/.env` 的本地 MySQL/Redis 配置，需要创建数据库权限。创建随机命名的临时测试数据库与独立 Redis 键前缀，启动真实后端；结束时只清理本次创建的数据。不会使用已有业务账号。种子数据为 11 个用户、10 个私聊会话、选中会话的 60 条历史消息；通过真实登录、好友接口和 WebSocket 消息入库生成。AI、MCP、音视频外部服务不在测量范围。

每组分别测冷缓存与热缓存，热缓存只预热首页。认证信息在导航前注入，不包含登录耗时。记录 FCP、LCP、10 个会话按钮全部完成布局的时间，以及点击会话后输入框出现、WebSocket 建连、历史消息到达和首批历史消息完成布局的耗时。`latestMessageRendered` 单独记录最新消息是否进入 DOM，false 是需要复查的功能问题，不冒充性能检查通过。首页资源在点击前采集；`jsGzipBytes` 为资源压缩体积，`jsNetworkGzipBytes` 仅累计实际网络传输的 JS，热缓存不能把资源体积当作下载量。缓存测试不使用 Playwright 请求拦截，以免自动禁用 HTTP 缓存；使用 CDP 屏蔽代码中已知的外部图片域名。

输出 `test-results/chat-first-screen/report.md`、`report.json` 与首页/会话截图。HTTP 网络使用相同模拟限速；本机 WebSocket 未必受该限速约束，交互数据不能当作公网连接延迟。对照组仍为当前工作区的措施消融，不是旧版系统。数据库规模和历史消息数量固定，不代表大规模业务性能。

## ORM / Go 改造评估

在仓库根目录运行：

```powershell
node qa/benchmarks/orm-go-evaluation.mjs
```

串行运行完整压力测试、16000 条真实消息突发、10/20/40 连接池诊断、原始 MySQL 吞吐、登录阶梯、默认 HTTP 限流及迁移/后端/系统/Agent 回归。已经单独运行完整压力测试时，可加 `--supplement` 跳过首项。每轮日志、诊断与退出码保存在唯一的 `test-results/orm-go-*/manifest.json` 所在目录；完整压力测试的原始报告路径也记录于 manifest。需要本地 MySQL/Redis 和创建数据库权限，沿用 `chat-backend.mjs` 的隔离与清理机制，不调用真实 AI 或 RTC 服务。

连接池诊断只调整隔离子进程配置，保留 Outbox、权限校验和持久化语义。三组为固定顺序的单次试验，含诊断开销，不能据此直接选定线上连接数。压测是本机闭环负载，延迟百分位仅统计成功请求；没有实现 ORM/Go 对照版本，因此不能宣称任何迁移加速倍数。默认限流检查严格要求 HTTP 429，实际返回 400 时保留失败结果。

## 消息入口保护

```powershell
node qa/benchmarks/message-protection.mjs
```

使用默认令牌桶和队列配置，串行测试 25 个私聊发送者与 50 人群内的 20 个发送者，各 15 秒。明确拒绝与意外错误分别统计；已接受消息要求真实接收、顺序及数据库审计通过。输出独立的 `test-results/message-protection-*/report.json` 和 `metrics.prom`。仅提高隔离子进程的 HTTP fixture 预算，消息准入保持默认值。

保护默认开启后，旧版以无限速发送为目标的脚本可能收到预期拒绝，不能继续要求其每次发送都成功，也不能与保护压测直接计算性能提升。保护链路与指标含义见 [项目说明](../../README.md#消息可靠性与过载保护)，参数见 [环境变量示例](../../server/.env.example)。

参数校准（固定提供速率，包含两个 50 人群，等待真实接收）：

```powershell
$env:CALIBRATION_PROFILES='steady'
$env:CALIBRATION_SECONDS='30'
$env:CALIBRATION_PHASES='normal,private-load,mixed,global-burst'
node qa/benchmarks/calibrate-admission.mjs
Remove-Item Env:CALIBRATION_PROFILES, Env:CALIBRATION_SECONDS, Env:CALIBRATION_PHASES
```

候选有 `current`（初始快照）、`balanced`、`high`、`conservative`、`steady`；不指定时串行比较全部候选，故意过载可能令某组不合格。`steady` 对应当前默认保护参数。输出 `test-results/admission-calibration-*/report.json`，包含接收延迟、明确拒绝、生成器丢弃、消息缺失及数据库审计。结果受本机硬件、群规模及运行负载影响，不能直接当作生产容量。报告与原始产物仅保留在本地，不提交到 Git。
