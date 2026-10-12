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
