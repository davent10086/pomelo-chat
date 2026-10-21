# 测试工程

所有常规测试通过根目录 `tests/run.cjs` 运行。本地与 CI 使用相同入口；新增测试由目录与后缀自动发现，无需维护执行清单。

| 命令 | 范围 | 外部依赖 |
| --- | --- | --- |
| `pnpm test:unit` | `tests/unit/**/*.test.{js,cjs,mjs}`，禁止网络连接 | 无 |
| `pnpm test:integration` | `tests/integration`，HTTP、WebSocket、事务、故障恢复 | MySQL、Redis |
| `pnpm test:e2e` | `tests/e2e/**/*.e2e.spec.ts`，浏览器关键流程 | MySQL、Redis、Chromium |
| `pnpm test:checks` | lint、前后端类型、Prisma schema、`tests/checks` 静态约束 | 无运行中服务 |
| `pnpm test:ci` | checks → build → unit → integration → e2e | 同上 |
| `pnpm test:security` | 三层中带 `security` 标签的用例 | MySQL、Redis、Chromium |
| `pnpm test:coverage` | 单元测试的 Node 覆盖率 | 无 |
| `pnpm test:qa` | 保留的综合协议与业务冒烟 | MySQL、Redis |
| `pnpm test:list` | 展示发现的用例与标签，不执行 | 无 |

`pnpm test` 等同单元测试；`test:all` 等同 `test:ci`。`test:full:server` 包含 checks、build、unit、integration；`test:full:browser` 等同 e2e。`test:database`、`test:api` 是集成层目录过滤。旧 `server/scripts/test-*.js` 及 `run-isolated-tests.js` 仅保留兼容转发。

## 环境

使用 Node 20.19+ / 22.12+、pnpm 10.19。安装后首次运行浏览器测试：

```powershell
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
$env:DATABASE_URL_TEST='mysql://test_admin:password@127.0.0.1:3306/pomelo_chat_test'
$env:REDIS_URL_TEST='redis://127.0.0.1:6379/15'
pnpm test:ci
```

URL 中的数据库名必须含独立的 `test` 段。测试账号需要创建、删除临时数据库的权限；无需预先创建 URL 中的库。未设置数据库测试 URL 时，兼容读取 `server/.env` 的 `DB_*` 管理连接。环境变量优先于该文件，生产模式直接拒绝运行。

每个集成文件拥有独立随机数据库、`test:<runId>:` Redis 前缀及 `tmp/tests/<runId>/` 附件目录。浏览器每批运行使用一组独立资源、动态 API/Web 端口，等待真实 readiness，禁止复用开发服务器。正常结束、失败和受控中断会回收所属资源；突然断电或强制杀死运行器不能保证执行清理。不要对共享 Redis 使用 FLUSHDB。

## 筛选与新增用例

```powershell
pnpm test:integration --filter assistant/
pnpm test:e2e --filter report-fixes
pnpm test:integration --tag regression
pnpm test:e2e --list
pnpm test:integration --timeout 180000
```

`--filter` 匹配仓库相对文件路径；`--tag` 读取文件头 `// @tags security regression`。未知原生测试参数报错；浏览器额外参数转交 Playwright。无匹配用例返回失败。标签用于横向选择，不另建一层安全测试。

单元测试验证纯规则、状态迁移与替身交互；需要真实网络、数据库、Redis、监听端口的测试放入集成层。端到端覆盖用户可见结果，不重复穷举单元参数矩阵。公共工具放在 `tests/helpers`；测试数据放在 `tests/fixtures`。历史 AI 评估夹具已分别归入单元与集成层，`node qa/ai-eval.js` 转发这两组测试。

## 报告与专项

每次顶层运行输出 `test-results/<runId>/report.json`，包含套件状态、用例计数、耗时、失败名称、日志和资源产物路径。各资源环境拥有单独 runId，报告通过 `resourceRunId` 关联。失败、超时、中断、清理失败和意外跳过均不会返回成功；缺失浏览器/QA JSON 报告也失败。QA 的在线模型检查明确列入 `excludedCases`，不计作通过。QA 警告视为未满足断言并使入口失败。

浏览器失败保留 trace 和截图；性能基线额外输出 `latency.json`。报告和日志保留，临时附件删除。覆盖率只代表单元运行实际加载的源码，不代表全仓或集成覆盖率；暂不设统一百分比门槛。

以下专项不属于默认 `test:ci`，报告显式列出排除范围：

- `pnpm test:rtc`：真实 LiveKit，配置 `LIVEKIT_HTTP_URL_TEST`、`LIVEKIT_URL_TEST`、`LIVEKIT_API_KEY_TEST`、`LIVEKIT_API_SECRET_TEST`；本机开发默认 7880/devkey/secret。服务必须使用 `room.auto_create=false`。默认集成/E2E 对 LiveKit 建房、删房使用替身，不能证明真实媒体回收。
- `pnpm test:desktop`、`test:desktop:smoke`：桌面规则与 Electron 冒烟；`test:desktop:production` 需先 `pnpm build:desktop`，Windows 安装产物连真实隔离后端。
- `pnpm test:performance`：单用户会话列表 100 次请求、并发 4 的延迟基线；`TEST_PERF_P95_MS` 默认 2000。它不代表整机容量。多实例、过载和额度校准工具见 `qa/benchmarks/README.md`，作为手动性能实验保留独立生命周期。
- `pnpm test:ai-live`：当前 UI 的真实在线模型冒烟，需要明确配置模型凭据，可能产生费用。默认三层会清空模型密钥，不发送在线请求。

过时 UI 用例归档于 `tests/legacy`，替代关系见 `qa/playwright/README.md`。归档不参与自动发现。
