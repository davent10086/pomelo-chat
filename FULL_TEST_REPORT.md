# Pomelo Chat 生产级全方位测试报告

测试日期：2026-07-27  
测试对象：`F:\pomelo-chat` 当前工作树  
测试方式：只读代码审计 + 本地命令验证 + 现有 QA/回归脚本执行 + 依赖安全审计 + 架构/容量推演  
约束说明：未修改业务代码；因 `eslint` 脚本自带 `--fix`，为遵守“不要直接修改代码”，未执行会自动改写源码的 lint 脚本，只执行/尝试只读等价命令。  

> 重要：当前工作树已有大量未提交变更，且本报告覆盖/更新了用户要求的 `FULL_TEST_REPORT.md`。

## 项目评分

总分：62 / 100

- 启动与构建：70 / 100。当前已安装依赖下 server/client 均可 build，但 server 全新安装不可复现。
- 代码质量：58 / 100。TypeScript 构建通过，但 lint 工具链不可用，文档/注释编码存在明显乱码。
- 前端质量：60 / 100。基础页面可构建，聊天消息未做虚拟列表，10k 消息和大媒体场景风险较高。
- IM / WebSocket：64 / 100。已有鉴权、房间权限、Redis fanout、clientMsgId 去重；但连接管理、状态语义、多端同步和压测体系不足。
- 后端/API：66 / 100。参数化 SQL 和服务分层基本具备；错误码语义、输入校验一致性、运行可观测性不足。
- 数据库：62 / 100。消息表有关键索引，但连接池、分库分表、归档、慢查询和百万/亿级容量方案缺失。
- AI 助手：63 / 100。有超时、限流、MCP 写工具确认；仍缺 LLM 失败矩阵、Agent 循环保护、流式恢复和评测门禁。
- 安全：55 / 100。已有若干加固，但依赖高危漏洞、Token 暴露面、上传/MCP/AI 安全边界仍需上线前补强。
- 部署/SRE：40 / 100。未发现 Docker、CI/CD、监控、日志采集、错误追踪、容量压测配置。

## 测试覆盖率

| 模块 | 覆盖情况 | 结论 |
| --- | --- | --- |
| 安装依赖 | `npm install --dry-run` 根包/client 通过；server 失败 | 不可生产交付 |
| 构建 | `npm --prefix server run build`、`npm --prefix client run build` 通过 | 可构建 |
| Lint | server ESLint 插件崩溃；client lint 脚本配置不可作为只读门禁 | 不可作为质量门禁 |
| Type check | build 内含 `tsc`，server/client 均通过 | 通过 |
| 单元/回归脚本 | `test:message-protocol`、`test:security`、`unit-agent-logic` 通过 | 局部通过 |
| 全量 QA | `node qa/qa-full-test.js` 失败：`fetch failed / ECONNRESET` | 未通过 |
| 依赖安全 | root 7、server 9、client 6 个生产依赖漏洞 | 未通过 |
| 真实压测 | 未发现 k6/artillery/autocannon 等脚本 | 未覆盖 |
| E2E | 存在 Playwright 用例，但未发现可直接执行的脚本入口 | 覆盖不足 |

## 执行结果摘要

### 项目启动状态

- 依赖安装：
  - `npm install --dry-run`：通过。
  - `npm --prefix client install --dry-run`：通过。
  - `npm --prefix server install --dry-run`：失败，`@typescript-eslint/eslint-plugin@7.18.0` 要求 `eslint ^8.56.0`，但项目锁定 `eslint 8.38.0`。
- 构建：
  - server build：通过。
  - client build：通过；主业务 chunk 约 `409.18 kB`、`434.47 kB`，gzip 后约 `132.31 kB`、`142.45 kB`。
- Lint：
  - server lint：失败，ESLint 8.38 与 `@typescript-eslint` 7.x 不兼容。
  - client lint：脚本为 `eslint --fix --max-warnings=0`，会修改代码，不适合 CI 只读门禁。
- Test：
  - `server test:message-protocol`：通过。
  - `server test:security`：通过。
  - `qa/unit-agent-logic.test.js`：通过。
  - `qa/qa-full-test.js`：失败，注册/请求流程触发 `ECONNRESET`。

## 严重问题

### P0：立即修复

#### P0-1 server 依赖无法从干净环境安装

- 文件位置：`F:\pomelo-chat\server\package.json:44`、`F:\pomelo-chat\server\package.json:52`
- 问题描述：`@typescript-eslint/eslint-plugin` / parser 使用 `^7.4.0`，实际解析到 7.18.0，其 peer dependency 要求 `eslint ^8.56.0`；项目锁定 `eslint 8.38.0`，导致 `npm install --dry-run` 失败。
- 严重等级：P0
- 复现方式：在 `F:\pomelo-chat` 执行 `npm --prefix server install --dry-run`。
- 修复建议：将 server 的 `eslint` 升级到 `^8.57.1` 或将 `@typescript-eslint/*` 固定到兼容 8.38 的版本；重新生成 lockfile；CI 增加 `npm ci`。

#### P0-2 全量 QA 冒烟测试失败

- 文件位置：`F:\pomelo-chat\qa\qa-full-test.js:85`
- 问题描述：全量 QA 在创建测试用户阶段请求失败，抛出 `fetch failed`，底层 `read ECONNRESET`。说明当前本地服务/API/数据库连接在真实流程下不稳定，无法证明核心业务闭环。
- 严重等级：P0
- 复现方式：确认服务运行后执行 `node qa\qa-full-test.js`。
- 修复建议：定位 server 在 `/auth/register` 或其依赖 DB/Redis 时是否进程崩溃；为 QA harness 增加服务启动检测、请求日志关联 ID、失败时 server 日志采集；修复后将该脚本纳入 CI。

#### P0-3 生产依赖存在高危漏洞

- 文件位置：`F:\pomelo-chat\package.json:21`、`F:\pomelo-chat\server\package.json:27`、`F:\pomelo-chat\client\package.json:18`
- 问题描述：`npm audit --omit=dev` 发现 root 7 个、server 9 个、client 6 个生产依赖漏洞。涉及 `express`、`ws`、`axios`、`react-router-dom`、`jws`、`path-to-regexp`、`@modelcontextprotocol/sdk` 等。
- 严重等级：P0
- 复现方式：分别执行 `npm audit --omit=dev`、`npm --prefix server audit --omit=dev`、`npm --prefix client audit --omit=dev`。
- 修复建议：优先升级 `express/body-parser/qs/path-to-regexp/ws`、`axios >= 1.18`、`react-router-dom` 到安全版本；升级后跑全量构建、QA、WebSocket 回归。

### P1：上线前修复

#### P1-1 Lint 门禁不可用且脚本会自动改代码

- 文件位置：`F:\pomelo-chat\server\package.json:18`、`F:\pomelo-chat\client\package.json:13`
- 问题描述：server lint 因依赖冲突崩溃；client/server lint 脚本均含 `--fix`，在 CI 或测试阶段会自动修改源码，不适合质量门禁。
- 严重等级：P1
- 复现方式：执行 `npm --prefix server run eslint` 或检查 package scripts。
- 修复建议：拆分 `lint` 与 `lint:fix`；`lint` 使用 `eslint src --ext .ts,.tsx --max-warnings=0`，`lint:fix` 才带 `--fix`。

#### P1-2 WebSocket 连接表为单进程内存态，缺少连接上限和心跳

- 文件位置：`F:\pomelo-chat\server\src\service\message\index.ts:11`、`F:\pomelo-chat\server\src\service\message\index.ts:494`
- 问题描述：`ChatRooms` 是进程内对象，只按 room/user 保存连接；没有连接数上限、心跳 ping/pong、僵尸连接清理、连接指标。虽然有 Redis fanout，但连接生命周期仍依赖单进程内存。
- 严重等级：P1
- 复现方式：模拟大量连接或异常断网，观察 `ChatRooms` 不可观测、无容量保护。
- 修复建议：增加 WS heartbeat、idle timeout、每用户/每 IP 连接上限、Prometheus 指标；多实例下用 Redis presence 记录在线端；压测 1000/10000 连接后设定容量阈值。

#### P1-3 消息状态模型不足，无法完整支持 sending/sent/delivered/read

- 文件位置：`F:\pomelo-chat\server\src\service\message\index.ts:313`、`F:\pomelo-chat\server\src\service\message\index.ts:292`
- 问题描述：服务端 `status` 主要是 0/1，私聊接收方在线即置 1，群聊直接置 1；前端将 ack 映射为 sent。无法区分 delivered 与 read，也不支持每消息/每成员 read receipt。
- 严重等级：P1
- 复现方式：用户 A 给离线 B 发消息、B 上线但不打开会话、B 打开会话，检查 DB `message.status` 与前端状态变化。
- 修复建议：引入 message_delivery / message_read 表或按 conversation/member 记录 last_delivered_seq、last_read_seq；状态机明确为 client pending、server persisted、delivered、read。

#### P1-4 前端 10000 消息场景缺少虚拟列表

- 文件位置：`F:\pomelo-chat\client\src\pages\chat\index.tsx`、`F:\pomelo-chat\client\src\components\MessageShow\index.tsx`
- 问题描述：构建依赖中没有 `react-window` 运行依赖，聊天渲染组件按消息逐条渲染；10k 消息、大图片、长文本场景会造成 DOM 和内存压力。
- 严重等级：P1
- 复现方式：构造 10000 条消息进入 `historyMsg/newMessage`，打开聊天页观察首次渲染耗时、滚动卡顿和内存。
- 修复建议：引入虚拟列表、图片懒加载、消息分页窗口、长文本折叠；增加 `qa/perf-chat-10k` 性能用例。

#### P1-5 数据库连接池和容量模型不支持 10 万在线/每秒 10000 消息

- 文件位置：`F:\pomelo-chat\server\src\model\db.ts:50`、`F:\pomelo-chat\server\src\model\db.ts:119`
- 问题描述：MySQL `connectionLimit` 固定为 10；消息写入每条包含事务、会话更新、统计更新、通知，缺少批处理、队列削峰、分区/归档策略。
- 严重等级：P1
- 复现方式：用 autocannon/artillery 模拟高并发发送消息，观察 DB 连接等待、事务延迟和错误率。
- 修复建议：连接池参数环境化；消息写入链路引入队列或批量写；message 表按时间/room 分区；读写分离；为 100k 在线建立容量模型。

#### P1-6 缺少 Docker、CI/CD、监控和错误追踪

- 文件位置：仓库根目录，未发现 `Dockerfile`、`docker-compose.yml`、`.github/workflows`
- 问题描述：无法证明环境隔离、镜像构建、自动测试、部署回滚、日志采集、监控告警。
- 严重等级：P1
- 复现方式：执行文件扫描或尝试按生产方式部署。
- 修复建议：新增 Dockerfile/docker-compose；CI 执行 `npm ci`、build、lint、test、audit；引入结构化日志、Prometheus/OpenTelemetry、Sentry 或同类错误追踪。

#### P1-7 Token 仍可能通过 URL/query 暴露

- 文件位置：`F:\pomelo-chat\client\src\utils\media-url.ts:9`、`F:\pomelo-chat\server\src\utils\authenticate.ts:109`、`F:\pomelo-chat\client\src\components\AudioModal\index.tsx:43`
- 问题描述：上传资源访问和 RTC WebSocket 将 token 放入 query string，可能进入浏览器历史、代理日志、Referer、监控日志。
- 严重等级：P1
- 复现方式：打开含 `/uploads?...token=` 或 `/rtc/connect?...token=` 的资源/WS，检查浏览器地址、Network、代理日志。
- 修复建议：优先使用 Authorization header、短期一次性下载票据、SameSite HttpOnly cookie 或 WebSocket subprotocol；日志中屏蔽 token query。

#### P1-8 AI Agent 外部 MCP 工具缺少统一超时/沙箱/出站策略

- 文件位置：`F:\pomelo-chat\server\src\service\assistant\tools\external-mcp.ts:83`、`F:\pomelo-chat\server\src\service\assistant\tools\external-mcp.ts:204`
- 问题描述：`MCP_SERVERS_JSON` 可配置 stdio/SSE/HTTP 外部工具，写工具有确认与审计，但缺少每工具超时、命令 allowlist、网络出站 allowlist、资源配额和循环调用上限。
- 严重等级：P1
- 复现方式：配置一个长时间不返回或异常输出的 MCP server，调用 agent/tools 或 agent chat，观察请求阻塞/资源占用。
- 修复建议：对每个 MCP tool call 设置 timeout、并发限制、allowlist、最大返回大小；Agent 层增加最大工具调用步数和循环检测。

#### P1-9 编码/文档乱码影响维护性

- 文件位置：`F:\pomelo-chat\README.md:1`、多处 TS 注释/文案
- 问题描述：README 与多处中文注释/字符串在当前环境显示乱码，降低维护、审查和面试展示质量。
- 严重等级：P1
- 复现方式：PowerShell `Get-Content README.md` 或打开部分源码注释。
- 修复建议：统一仓库编码为 UTF-8；添加 `.editorconfig`；重新保存中文文档；CI 增加编码/非法字符检查。

### P2：优化

#### P2-1 API 错误响应语义不够细

- 文件位置：`F:\pomelo-chat\server\src\service\message\index.ts:467`、`F:\pomelo-chat\server\src\service\assistant\agent.ts:558`
- 问题描述：多处异常统一返回通用错误码，客户端难以区分参数错误、权限错误、限流、上游失败、超时。
- 严重等级：P2
- 复现方式：传入非法 room、非法 agent 参数、上游 AI 失败，比较 HTTP status 与业务 code。
- 修复建议：定义统一错误模型：HTTP status + business code + requestId；保留安全边界但提升可诊断性。

#### P2-2 上传合并缺少 totalCount 连续性校验

- 文件位置：`F:\pomelo-chat\server\src\service\file\index.ts:128`
- 问题描述：`mergeFile` 根据目录中 `chunk-\d+` 排序合并，但未接收/校验 totalCount 与每个 chunk 的连续性、大小、hash。
- 严重等级：P2
- 复现方式：上传 `chunk-1` 和 `chunk-3` 后调用 merge，观察是否能产生缺块文件。
- 修复建议：merge 时要求 totalCount、完整 chunk index 集合、文件 hash 二次校验；上传元数据落库标记状态。

#### P2-3 AI SSE 流中断恢复未覆盖

- 文件位置：`F:\pomelo-chat\server\src\service\assistant\index.ts:150`、`F:\pomelo-chat\server\src\service\assistant\agent.ts:521`
- 问题描述：服务端支持 SSE 转发，但没有事件 id、断点恢复、首 token 计时、流中断后的客户端重试协议。
- 严重等级：P2
- 复现方式：请求 `/assistant/chat/stream` 后中途断网，再恢复网络，观察是否能续传或明确失败。
- 修复建议：增加 SSE event id、客户端 abort/retry 策略、首 token/总耗时指标；失败时返回可重试错误。

#### P2-4 魔法数字散落

- 文件位置：`F:\pomelo-chat\server\src\service\message\index.ts:19`、`F:\pomelo-chat\server\src\service\assistant\index.ts:17`
- 问题描述：消息长度、历史分页、AI 超时、限流等常量散落在服务文件中，部分不可环境化。
- 严重等级：P2
- 复现方式：搜索 `MAX_`、`30000`、`10000`、`20`。
- 修复建议：集中到 config 模块，生产按环境变量配置，并在启动时校验范围。

#### P2-5 缺少重复代码/死代码自动检测

- 文件位置：仓库根目录 `package.json`
- 问题描述：未发现 knip/ts-prune/jscpd 等脚本；死代码、重复代码只能人工审查。
- 严重等级：P2
- 复现方式：检查 scripts。
- 修复建议：增加 `knip` 检测未使用导出、`jscpd` 检测重复代码、`depcheck` 检测未使用依赖。

## 前端测试结论

- 组件渲染：未发现组件单测框架（Vitest/Jest/RTL），无法自动证明 Props 异常、State 异常、空状态。
- 页面路由：有 React Router 私有路由；鉴权依赖 `sessionStorage` token。
- 加载/错误/空状态：聊天消息、AI、上传有局部状态，但缺少系统化 E2E 覆盖。
- 性能：
  - 10k 消息：高风险，缺虚拟列表。
  - 大量图片：每条非文本消息会触发 URL/媒体尺寸探测，可能造成网络和布局压力。
  - 长文本：React 默认转义可降低 XSS 风险，但长文本折行/折叠/复制体验需测。
  - 高频消息刷新：`setNewMessage([...previous])` 逐条增长，大量推送时渲染压力明显。

## 即时通讯核心测试结论

- 单聊/群聊：代码具备私聊/群聊 room 权限校验与历史消息查询。
- 发送/接收：WebSocket 写 DB 后本地广播 + Redis fanout；存在 ack。
- 撤回/删除：未发现服务端撤回消息、删除消息 API；前端删除为本地隐藏。
- 历史消息：支持 `beforeId` + limit 游标分页，默认 30，最大 80。
- 可靠性：支持 `clientMsgId` 去重；但乱序、丢失、服务重启、多端同步未形成完整协议。
- 多端：同账号多个客户端目前按 user id 覆盖 `ChatRooms[room][id]`，可能无法同时保存同一用户多个连接。

## WebSocket 测试结论

- 长连接管理：有连接、关闭、错误处理。
- 心跳机制：未发现服务端 ping/pong。
- 重连机制：前端有指数退避重连。
- 超时处理：前端连接超时 10s；服务端无 idle timeout。
- 并发连接：未发现 1000/10000 连接压测脚本。
- 记录 CPU/内存/延迟/错误率：当前未覆盖，需要引入压测和指标。

## 后端测试结论

- API 参数校验：核心路径有基础校验，但分散且不完全一致。
- 返回格式：存在 `RespData/RespError` 封装。
- 错误处理：多数 catch 返回通用错误，日志有 requestId 但未形成链路追踪。
- Service/Controller：Controller 较薄，Service 承担业务；整体分层尚可。
- 数据访问：大多使用参数化 SQL；迁移脚本中记录 migration id 使用字符串拼接，但 id 来自固定数组，当前风险低。

## 数据库测试结论

- 表设计：包含 user、friend、group、message、conversation、conversation_read、assistant_memory、assistant_task、mcp_audit_log。
- 索引：message 表已有 `(room,id)`、`(room,created_at)`、`(receiver_id,status,room)`、`(conversation_id,room_seq)`。
- 慢查询风险：chat list 中多表 join + 子查询统计未验证大数据性能。
- 百万级消息：索引具备基础支撑，但缺分区/归档/冷存储/读写分离压测。
- 10 万用户：当前连接池和单体 WS 架构不足以证明支撑。

## AI 助手测试结论

- LLM 调用：有 30s 超时、API key 后端化、服务端模型固定。
- API 失败/限流：有通用错误与每用户每分钟 20 次限流。
- Streaming：支持 SSE，但缺首 token 指标和中断恢复。
- 上下文：限制 messages 数量和长度；未发现历史压缩策略的自动测试。
- Memory：有保存/搜索/忘记工具，禁止保存 secret 的规则存在；需增加误存/误召回评测。
- Agent/Tool/MCP：有工具列表、工具调用、写工具确认和审计；缺工具调用循环、超时、最大输出和外部工具沙箱。

## 安全风险

1. 高危依赖漏洞未修复：P0。
2. Token query 暴露：P1。
3. WebSocket 依赖与连接耗尽 DoS 风险：P1。
4. MCP 外部工具边界不足：P1。
5. 文件上传合并完整性不足：P2。
6. AI Prompt Injection 防护主要依赖提示词和简单 sanitize，缺红队测试集与越权工具调用回归：P2/P1。

## 性能风险

- 聊天 10k 消息渲染无虚拟列表。
- WebSocket 无真实 1000/10000 连接压测。
- 每秒 10000 消息需要队列、批量写、分区表和水平扩容；当前单体 + MySQL pool 10 不足。
- AI 接口每用户限流有了，但缺全局限流、并发池、熔断和降级。
- 文件上传跳过通用 API 限流，需单独按用户/IP/文件 hash 限流。

## 架构风险

- 单体 Express 同时承载 API、WS、AI、MCP，生产故障域较大。
- 在线状态和连接状态内存化，多实例一致性不足。
- 数据迁移与应用启动耦合，启动失败可能直接 `process.exit(1)`。
- 缺少部署工件、CI/CD、监控告警、容量基线。

## 面试展示建议

建议把项目包装成“AI Native IM 系统”的工程化案例，但先补齐以下展示点：

1. 一张架构图：Client / API / WS Gateway / Message Service / MySQL / Redis / AI Agent / MCP。
2. 一组可靠性能力：clientMsgId 幂等、room_seq 顺序、read receipt、多端同步。
3. 一组压测数据：1000 WS、10k 消息渲染、API QPS、DB 慢查询。
4. 一组安全能力：JWT + Redis 白名单、上传鉴权、MCP 写工具确认、Prompt Injection 红队集。
5. 一条 CI 绿线：install/build/lint/test/audit 全通过。

## 下一阶段优化路线

### 第 1 周：上线阻断项

- 修复 server 安装冲突。
- 拆分 `lint` / `lint:fix`。
- 升级高危依赖。
- 修复 `qa-full-test.js` ECONNRESET。
- 建立 CI：install、build、lint、test、audit。

### 第 2 周：IM 可靠性

- 补齐 delivered/read 状态模型。
- 支持同账号多连接。
- 服务端 WS heartbeat + idle cleanup。
- 增加消息乱序、重复、断线、服务重启回归测试。

### 第 3 周：性能和容量

- 前端虚拟列表。
- 后端引入 WS/API 压测脚本。
- MySQL 慢查询分析、连接池环境化、message 分区/归档方案。
- 建立 CPU/内存/延迟/错误率基线。

### 第 4 周：AI 与安全生产化

- Agent 最大步数、工具超时、MCP allowlist。
- Prompt Injection / 数据泄露 / 越权工具调用红队集。
- AI SSE 首 token 指标和流中断处理。
- 上传文件完整性校验和短期下载票据。

## 附：本次执行命令

```text
npm install --dry-run
npm --prefix client install --dry-run
npm --prefix server install --dry-run
npm --prefix server run build
npm --prefix client run build
npx --prefix server eslint server/src --ext .ts --max-warnings=0
npx --prefix client eslint client/src --ext .ts,.tsx --max-warnings=0
npm --prefix server run test:message-protocol
npm --prefix server run test:security
node qa\qa-full-test.js
node qa\unit-agent-logic.test.js
npm audit --omit=dev --json
npm --prefix server audit --omit=dev --json
npm --prefix client audit --omit=dev --json
```
