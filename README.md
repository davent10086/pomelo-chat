# Pomelo Chat

Pomelo Chat 是一个即时通讯应用原型，前端提供类微信聊天体验，后端通过 HTTP、WebSocket、MySQL、Redis 和 LangChain Agent 支撑用户、好友、群聊、文件、RTC 信令和 AI 助手能力。

本文只描述当前仓库代码中已经存在的能力。

后端已采用模块化单体：认证、社交、消息、文件、RTC、助手和实时连接通过公开接口协作，业务用例与 HTTP/SSE/WebSocket 适配器分离；保持单进程和现有启动方式。模块职责、事务规则和 CI 边界检查见 [后端架构说明](server/ARCHITECTURE.md)。

Windows 桌面开发原型已提供：微信风格主窗口、右侧贴边可折叠 AI 助手、柔和动画与当前聊天关联。
启动方式：先运行 `pnpm dev:server`，再在另一个终端运行 `pnpm dev:desktop`。
环境配置和验证方法见 [桌面原型说明](desktop/README.md)。

### 桌面界面预览

![聊天主窗口与贴边 AI 助手](docs/images/desktop-ui.png)

图中会话使用模拟测试数据。主窗口采用微信风格的导航栏、会话列表和聊天区，AI 助手在右侧零间隙贴合，展开时与主窗口等高，折叠后保留侧边标签。

- 调整会话列表、聊天区与助手的比例，统一两侧输入区高度，用底色和分隔线区分区域。
- 登录和注册页统一为浅绿色柔光背景与白色表单卡片，适配桌面和手机尺寸。
- 桌面助手支持流式对话、停止生成、聊天总结、回复建议与复制；用户主动开启当前聊天关联。
- 两个窗口同步登录与退出状态，折叠不打断生成；最小化一起隐藏，关闭主窗口退出应用。

桌面侧栏助手当前提供对话、总结、回复建议和复制，没有写操作确认入口；主聊天页面的 AI Copilot 提供确认式发消息、保存待办和记忆操作。

## 架构总览

```mermaid
flowchart LR
  User["用户浏览器或 Electron 桌面窗口"] --> Client["前端：React + Vite + Ant Design"]
  Client -->|HTTP JSON| API["后端：Express REST /api/chat/v1"]
  Client -->|WebSocket| WS["server: express-ws"]

  API --> Auth["JWT + Redis Token 白名单"]
  API --> MySQL[("MySQL")]
  API --> Redis[("Redis")]
  WS --> MySQL
  WS --> Redis

  API --> Assistant["AI 助手服务"]
  Assistant --> Agent["LangChain Agent"]
  Agent --> LLM["兼容 DeepSeek 的 ChatOpenAI"]
  Agent --> BuiltinTools["Pomelo 内置工具"]
  Agent --> ExternalMCP["外部 MCP 服务"]
  BuiltinTools --> MySQL
```

## 核心能力

- 用户注册、登录、登出、验证旧密码后修改密码、资料更新；暂不提供忘记密码后的短信或邮件找回流程。
- 好友分组、好友搜索、好友添加、通讯录展示。
- 单聊和群聊消息，WebSocket 实时收发，MySQL 持久化。
- 私聊已读回执：单勾表示已发送，蓝色双勾表示对方已读；私聊、群聊均支持未读数与已读游标。
- 群创建、群成员查询、邀请入群。
- 文件分片上传、合并与受控访问。
- LiveKit SFU 音视频通话（本地演示配置）。
- AI 助手问答、SSE 流式接口、Agent 执行链路、用户隔离的助手记忆、确认式动作与个人任务。
- 本地 MCP stdio server，以及外部 MCP 配置加载。

## 技术栈

| 层级 | 实现 |
| --- | --- |
| 前端 | React 18, TypeScript, Vite, Ant Design, React Router, Axios, Less |
| 后端 | Node.js, Express, express-ws, TypeScript |
| 数据 | MySQL, Redis ioredis |
| 认证 | JWT, Redis token whitelist |
| AI | LangChain `createAgent`, `ChatOpenAI`, DeepSeek-compatible API |
| MCP | `@modelcontextprotocol/sdk`, stdio / SSE / streamable HTTP |
| 文件 | Multer, Node.js fs, uploads 静态受控访问 |

## 代码结构

```text
.
├── client/                  # React 前端
│   ├── src/config/           # API / WebSocket base URL
│   ├── src/hooks/            # AI 助手等业务 hooks
│   ├── src/pages/            # 页面
│   └── src/utils/            # axios、WebSocket 等工具
├── desktop/                 # Electron 桌面主窗口、侧栏助手与桌面测试
├── server/                  # Express 后端
│   ├── src/controller/       # 路由注册
│   ├── src/infrastructure/   # MySQL、Redis、文件存储与 HTTP 基础设施
│   ├── src/model/            # 数据库迁移命令与配置
│   ├── src/modules/          # identity/social/messaging/files/rtc/assistant/realtime
│   ├── src/mcp/              # Pomelo MCP stdio server
│   └── scripts/              # Agent/MCP/安全回归脚本
├── qa/                      # QA 自动化、Postman、AI 评测集
├── tests/                   # Node 单元与数据库安全边界测试
├── .github/workflows/       # GitHub Actions CI
├── pnpm-workspace.yaml      # pnpm workspace 定义
├── pnpm-lock.yaml           # 唯一依赖锁文件
└── README.md
```

## 后端路由

所有 REST API 前缀为 `/api/chat/v1`。

| 路由 | 用途 |
| --- | --- |
| `/auth` | 用户认证、用户信息、用户 WebSocket channel |
| `/friend` | 好友、好友分组、搜索、添加 |
| `/group` | 群列表、群信息、建群、邀请、成员 |
| `/message` | 聊天列表、历史分页、搜索与上下文、消息核对、已读游标及私聊回执、聊天 WebSocket |
| `/file` | 文件校验、分片上传、合并 |
| `/rtc` | 音视频通话信令 |
| `/assistant` | AI 聊天、流式聊天、Agent、工具调用、确认/取消动作、个人任务 |

## 本地多人音视频（LiveKit）

通话使用 LiveKit SFU，而不是浏览器之间的 Mesh P2P。启动本地媒体服务：

```bash
docker compose -f docker-compose.livekit.yml up -d
```

默认地址是 `ws://127.0.0.1:7880`，服务端默认 key/secret 为 `devkey`/`secret`，仅可用于本地演示。前后端启动后，用三个独立浏览器配置文件登录同一群聊即可联调语音或视频通话。媒体 UDP 端口范围为 `50000-50100`，HTTP/WebSocket 为 `7880`，RTC TCP 回退端口为 `7881`。

本地部署固定为 LiveKit `v1.13.9`，已与当前客户端完成真实媒体回归。启动 LiveKit 后运行 `pnpm test:real-rtc`：测试会启动隔离的前后端，用两个 Chromium 浏览器验证私聊语音和视频的邀请、接听、双向 RTP 数据接收、视频画面解码和挂断清理。摄像头和麦克风使用浏览器生成的测试媒体，不访问物理设备；HTTP、信令和媒体传输均不模拟。本机 Redis 仅监听 IPv6 时，先设置 `$env:REDIS_URL_TEST = 'redis://[::1]:6379/15'`。测试不覆盖跨公网 NAT/TURN、物理设备和群通话。

可通过环境变量覆盖服务端连接信息：`LIVEKIT_URL`、`LIVEKIT_HTTP_URL`、`LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET`。`POST /rtc/join-token` 会在验证当前用户是该私聊/群聊成员后，返回仅限对应房间、10 分钟有效的发布与订阅 token；`POST /rtc/invite` 仅投递业务邀请，不转发 SDP 或 ICE candidate。

## 消息链路

```mermaid
sequenceDiagram
  participant C as Client
  participant P as Peer Client
  participant H as HTTP API
  participant W as WebSocket Route
  participant D as MySQL
  participant F as Outbox Worker
  participant R as Redis Fanout

  C->>W: connect_chat?room&id&type (Sec-WebSocket-Protocol token)
  Note over W,R: 验证 JWT、Redis 会话及房间访问权限
  W->>D: 读取历史消息与对方已读游标
  W-->>C: history (messages, hasMore, nextBeforeId, peerReadSeq)
  C->>W: message JSON (clientMsgId)
  W->>D: 事务写入消息、房间序号、统计及 outbox
  D-->>W: commit
  W-->>C: ack (id, client_msg_id, room_seq)
  Note over W,F: ACK 与异步投递的到达顺序不固定
  F->>D: 按房间顺序领取待投递消息
  F->>R: 发布跨实例消息
  F-->>C: 投递本地连接，按消息 ID 合并
  F-->>P: 投递接收方连接
  Note over F,R: 其他实例通过 Redis 订阅投递；失败重试，至少一次语义
  P->>H: POST /message/read (room, type, roomSeq)
  H->>D: 验证访问权限后单调推进已读游标
  H->>R: 发布私聊 read_receipt
  H-->>C: 向本地聊天连接投递 read_receipt
  Note over C,P: 重连读取 history；消息缺口通过 /message/history 补齐
```

私聊发送成功显示单勾；收到对方的 `read_receipt` 后，相应消息变为蓝色双勾，悬停提示“对方已读”。刷新或重连后通过 `peerReadSeq` 恢复状态，迟到回执不会使已读进度倒退。群聊暂不展示双勾或已读成员列表。

只有聊天页面可见、消息同步完成且位于底部时，客户端才上报当前消息序号；搜索、历史定位和后台页面不推进已读游标。服务端将上报序号限制在房间实际最新序号以内，并在授权后持久化。

## AI Agent 与 MCP

AI 聊天、总结和回复建议统一使用 `/assistant/agent` 与 `/assistant/agent/stream`；旧 `/assistant/chat`、`/assistant/chat/stream`、`/assistant/next-steps` 已移除，前后端需同步升级。总结与回复建议使用 `context.readOnly: true`，不调用模型工具、不读取长期记忆、不产生确认操作。普通 Agent 对话仍通过显式确认执行写操作。

```mermaid
flowchart TB
  Input["用户输入"] --> Coordinator["coordinator_agent"]
  Coordinator --> Intent["intent classify: chat/context/todo/reply/mixed"]
  Intent --> Context["chat_context_agent"]
  Intent --> Todo["todo_agent"]
  Intent --> Reply["reply_agent"]
  Context --> Recent["get_recent_messages"]
  Todo --> Extract["extract_todos"]
  Reply --> Suggest["suggest_replies"]
  Recent --> Compose["Agent prompt compose"]
  Extract --> Compose
  Suggest --> Compose
  Compose --> Model["ChatOpenAI DeepSeek-compatible"]
  Compose --> Memory["search_memory / memory proposal"]
  Compose --> MCP["External MCP tools"]
  Model --> Output["Markdown response + agentSteps/toolTrace"]
```

内置工具位于 `server/src/modules/assistant/tools/pomelo-tools.ts`：

- `get_recent_messages`
- `search_messages`、`get_message_context`：在已授权会话内搜索文本并读取命中消息的前后文。
- `list_my_tasks`：按状态读取当前用户保存的个人任务。
- `search_contacts`
- `search_groups`
- `extract_todos`
- `suggest_replies`
- `search_memory`
- `save_memory`、`forget_memory`：仅在确认动作执行时写入；删除记忆按当前用户的记忆 ID 精确定位，确认时显示目标内容。通用工具接口会先返回待确认动作，本地 stdio MCP 不暴露这两个写工具。

外部 MCP 配置由 `MCP_SERVERS_JSON` 读取，实现在 `server/src/modules/assistant/adapters/external-mcp.ts`。本地 stdio MCP server 位于 `server/src/mcp/pomelo-stdio.ts`，启动脚本为 `pnpm --filter pomelo-chat-server mcp:stdio`。每个外部服务必须用 `allowedUserIds` 指定一个获授权的用户，并通过 `readTools`、`writeTools` 显式列出可用工具；未列出的工具不会暴露。不同用户应使用不同名称和凭据的服务配置，避免共享远端会话。写工具还须在 `idempotencyKeys` 中配置参数名，且远端工具输入 schema 必须把该参数列为必填字符串；远端也必须用此参数去重。缺少该契约的已声明写工具不会暴露。示例：`{"name":"calendar_user_1","url":"https://example.com/mcp","allowedUserIds":[1],"readTools":["list_events"],"writeTools":["create_event"],"idempotencyKeys":{"create_event":"requestId"}}`。

内置工具以 Zod 作为参数和结果契约的唯一来源，自动生成 MCP 的 `inputSchema` / `outputSchema`。查询词最长 120 字符，建议和提取文本最长 20000 字符，条数参数必须为范围内整数。空查询结果正常返回；无权限或不存在的目标统一返回 `TARGET_UNAVAILABLE`，不泄露目标是否存在。工具失败使用 `isError` 和稳定错误码；数据库等内部错误不会直接返回给模型或客户端。

所有内部工具执行及外部 MCP 调用共用 Redis 原子限流：每个用户每 60 秒最多 120 次，与 Agent 请求限流分开计数；Redis 不可用时暂停工具执行。外部工具保留远端 JSON Schema，并按 `nextCursor` 完成分页；重复游标、重复工具名或重复服务名会被拒绝。模型可见名称由服务名、工具名及稳定身份摘要组成，最长 63 字符。升级后须重新发现工具，已有外部工具待确认动作需取消后重新提出，不使用旧名称猜测匹配。

`pnpm --filter pomelo-chat-server test:tool-contracts` 验证契约一致性、输入边界、错误脱敏、分页、名称冲突及真实 Redis 并发限流；已加入 `pnpm test:integration`。`test:mcp` 额外检查 stdio 输出、结构化结果和参数错误。

Agent 产生的发消息草稿、任务创建和外部 MCP 写操作都必须经用户确认。待确认期限保存在 Redis，执行状态及结果保存在 MySQL；`GET /assistant/actions/:id` 可查询结果。服务端会再次校验用户、聊天目标与动作有效期；确认后可通过 `/assistant/tasks` 查看和更新个人任务。AI 助手窗口可选择会话整理最近 30 条消息的事项，并逐项勾选保存。

## 数据模型

启动后端时，`server/src/infrastructure/database.ts` 会按顺序创建以下 MySQL 表：

```mermaid
erDiagram
  user ||--o{ friend_group : owns
  friend_group ||--o{ friend : contains
  user ||--o{ group_chat : creates
  group_chat ||--o{ group_members : has
  user ||--o{ group_members : joins
  user ||--o{ message : sends
  user ||--o{ assistant_memory : owns
  user ||--o{ assistant_task : owns
  conversation ||--o{ conversation_read : tracks
  conversation ||--o{ message : sequences

  user {
    int id
    varchar username
    varchar password
    varchar phone
    varchar avatar
    varchar name
  }
  message {
    int id
    int sender_id
    int receiver_id
    varchar room
    enum type
    enum media_type
    longtext content
  }
  assistant_memory {
    int id
    int user_id
    varchar category
    varchar content
  }
  conversation {
    int id
    varchar room
    bigint last_seq
  }
  conversation_read {
    int conversation_id
    int user_id
    bigint last_read_seq
  }
  assistant_task {
    int user_id
    varchar title
    enum status
  }
```

此外还有 `message_statistics`、`file_metadata`、`schema_migrations` 和 `mcp_audit_log`，分别用于消息计数、受控文件元数据、兼容迁移记录和 MCP 操作审计。

## 环境变量

后端常用配置：

```env
PORT=3000
JWT_SECRET=change-me

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=pomelo-chat

REDIS_URL=
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
REDIS_KEY_PREFIX=

CORS_ORIGINS=http://localhost:5173
REQUEST_LOGS=true
API_RATE_LIMIT_WINDOW_SECONDS=60
API_RATE_LIMIT_MAX=240
JSON_BODY_LIMIT=2mb
FORM_BODY_LIMIT=2mb
MAX_UPLOAD_CHUNKS=100
MAX_UPLOAD_SIZE_BYTES=104857600

DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat

MCP_SERVERS_JSON=[]
POMELO_MCP_USER_ID=1
POMELO_MCP_ROOM=

LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_HTTP_URL=http://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

测试运行必须使用隔离服务，不能使用生产数据库或 Redis：

```env
DATABASE_URL_TEST=mysql://root:password@127.0.0.1:3306/pomelo_chat_test
REDIS_URL_TEST=redis://127.0.0.1:6379/15
```

前端常用配置：

```env
VITE_API_BASE=http://127.0.0.1:3000/api/chat/v1
VITE_WS_BASE=ws://127.0.0.1:3000/api/chat/v1
VITE_SERVER_URL=http://127.0.0.1:3000
VITE_SERVER_PORT=3000
```

未配置 `VITE_API_BASE` / `VITE_WS_BASE` 时，前端会根据当前浏览器 host 拼接后端地址，方便局域网调试。

## 本地运行

准备 Node.js 20（与 CI 一致）、MySQL 8+ 和 Redis，并先创建 `DB_NAME` 指定的数据库。后端会创建和迁移表结构，不会自动创建数据库。首次运行复制环境变量示例，填写数据库凭据、JWT 密钥以及需要使用的模型配置；已有 `.env` 时直接修改，不要覆盖：

```powershell
Copy-Item server/.env.example server/.env
Copy-Item client/.env.example client/.env
```

```powershell
corepack enable
pnpm install --frozen-lockfile
```

在两个终端分别启动后端和前端：

```powershell
# 终端 1
pnpm run dev:server
# 终端 2
pnpm run dev:client
```

构建：

```powershell
pnpm run build
```

## 测试与 QA

先创建专用测试数据库并设置连接串，再执行需要数据库的测试。下列地址和密码需要替换为本机隔离服务配置；`test:all` 不会自动创建该数据库：

```powershell
$env:DATABASE_URL_TEST='mysql://root:password@127.0.0.1:3306/pomelo_chat_test'
$env:REDIS_URL_TEST='redis://127.0.0.1:6379/15'

pnpm lint
pnpm test:all
pnpm audit --prod --audit-level=high

pnpm --filter pomelo-chat-server test:agent-routing
pnpm --filter pomelo-chat-server test:agent
pnpm --filter pomelo-chat-server test:mcp
pnpm --filter pomelo-chat-server test:security

node qa/unit-agent-logic.test.js
node qa/ai-eval.js
pnpm test:qa
```

补充产物：

- `PROJECT_TEST_MAP.md`
- `MCP_TEST_REPORT.md`
- `QA_REPORT.md`
- `qa/postman_collection.json`
- `qa/playwright/ai-assistant.e2e.spec.ts`
- `qa/ai-eval-cases.json`

`pnpm test:qa` 会启动测试模式后端，要求显式传入名称含 `test` 的 MySQL URL 和测试 Redis URL；它使用 runId 前缀创建数据，并在结束时清理数据库、Redis key 和临时文件。默认不调用真实 LLM；设置 `QA_RUN_LIVE_AI=true` 并提供隔离凭据才会执行真实模型检查。

P0/P1 系统回归与浏览器回归：

```powershell
# 已设置上述隔离测试连接串后
pnpm --filter pomelo-chat-server test:db-migrations
pnpm test:system
pnpm exec playwright install chromium
pnpm test:e2e

# 本地也可使用 server/.env 的连接凭据自动创建、清理独立测试数据库
node server/scripts/run-isolated-tests.js system
node server/scripts/run-isolated-tests.js migrations
node server/scripts/run-isolated-tests.js browser
```

系统回归覆盖事务消息、投递故障恢复、附件权限、历史序号修复、已读游标、并发注册、会话撤销和通话状态。浏览器回归覆盖登录、发消息、AI 建议、流式更新和修改密码；AI 响应使用确定性桩，不消耗模型额度。浏览器测试默认使用 5199/3199 端口，需要 MySQL 8+ 和 Redis。

升级前备份数据库并运行 `pnpm --filter pomelo-chat-server db:migrate`。迁移会修复历史房间序号和已读游标，新增附件引用、投递 outbox、好友和手机号唯一约束；发现重复手机号或同一用户重复好友时会中止并提示清理，不会自动删除业务数据。

## 普通聊天恢复与会话搜索

普通单聊、群聊发送前会把文本和已上传附件的引用保存到 IndexedDB；刷新、重连及确认超时后，先通过 `POST /message/resolve` 核对服务端，再使用原 `clientMsgId` 重发。跨标签页使用原子发送租约，服务端事务幂等约束承担最终去重。每轮自动重试最多三次，间隔 1、3、10 秒；超过 24 小时需手动重试，队列最多保留七天、每用户 100 条。失败消息支持重试与取消，取消不会撤回已经提交的消息。登出清除当前用户队列；存储失败会提示，并保留当前页面的发送、重试能力。队列不保存文件二进制或助手请求。

会话标题旁的“搜索聊天记录”支持正文关键词、上海时区日期范围、发送者及消息类型筛选。`GET /message/search` 按消息 ID 游标分页，默认 20、最多 50 条；文本关键词按字面子串匹配。`GET /message/context` 返回授权会话内目标消息及前后各最多 20 条。点击结果进入独立历史视图，可加载两侧历史并返回最新消息。搜索、历史定位和后台页面不推进已读游标。

消息服务按权限、查询、事务写入、投递、HTTP、WebSocket 拆分；旧 `service`、`utils` 和 `model/db` 兼容门面已移除，跨模块调用使用 `public.ts` 或 `contracts.ts`。Redis 订阅和 outbox 由服务启动/关闭显式管理。启动兼容迁移可重复执行，并补充 `(room, type, id)` 索引。聊天页面通过会话列表、助手会话、连接同步、发送队列、历史定位和已读 hooks 分担状态。

新增浏览器回归覆盖 ACK 丢失后刷新、离线发送恢复、多标签页恢复、旧消息搜索定位，以及真实 IndexedDB 的租约、容量、过期和账号隔离。系统回归在隔离 MySQL/Redis 中验证搜索权限、特殊字符、筛选、日期边界、游标和消息核对；运行 `node server/scripts/run-isolated-tests.js system` 或 `browser`。助手响应使用确定性桩。

## 会话状态与后台资源生命周期

聊天状态通过明确操作管理：普通会话提供发送、重试、取消、分页和定位；助手会话独立持有消息、流式请求、事项和记忆状态；页面不接收消息数组 setter 或流式控制 ref。切换会话会取消旧流和 HTTP 请求，并通过会话版本校验阻止迟到结果更新界面。

后端 `server/src/runtime.ts` 统一启动/关闭会话订阅、通知投递、消息投递、会话检查与通话超时任务；模块导入不建立 Redis 连接或启动周期任务。通知连接使用专用注册表管理，移除 `global.LoginRooms`。HTTP 服务关闭时停止接收连接、关闭 WebSocket、等待在途 outbox 工作，并释放订阅、在线心跳、外部 MCP 客户端、Redis 与 MySQL。后台运行时可以重复启动和关闭。

好友和群聊搜索保持数组响应，支持 `afterId` 游标和 `limit`（默认 30，最大 100），按 ID 升序返回；下一页传上一页最后一项的 `id` 或 `group_id`。搜索关键词中的 `%`、`_` 按字面匹配。弹窗支持加载更多，并取消过时请求。

消息 outbox 使用 MySQL 8 的 `FOR UPDATE SKIP LOCKED` 领取记录，每个房间只领取最早的待投递消息；每个实例最多并行投递 8 个房间，领取租约为 60 秒并定期续租。实例故障后租约过期可重试，完成和释放操作校验领取令牌。投递仍是至少一次语义：发布成功但完成记录失败时可能重复，客户端按消息 ID 合并。WebSocket 待发送缓冲超过 1 MiB 时断开，由客户端重连并通过历史消息恢复。

运行 `node server/scripts/run-isolated-tests.js backend` 可创建并清理独立测试数据库，验证接口响应、权限、分页、通知失败、竞争领取、房间顺序、慢房间隔离、失败重试和租约恢复；该套测试也已加入 `pnpm test:all`。

系统测试验证导入无后台副作用、重复启动、资源清理、重启，以及真实服务进程带通知 WebSocket 的完整退出；新增浏览器测试验证延迟历史、助手流、事项筛选和卸载时的记忆请求不会污染新界面。

## 聊天界面交互

输入草稿按用户和会话隔离，保存在当前标签页的 sessionStorage 中，切换会话或刷新后恢复文本及光标；退出登录清除当前用户草稿。浏览器存储不可用时退回页面内存，仍能在本页切换会话恢复草稿，但刷新无法恢复。提交发送后清除对应草稿，不覆盖等待回复期间的新输入。

会话列表支持按名称或联系人账号筛选，通讯录支持按联系人备注、账号或群名筛选；添加入口使用可点击、键盘可操作的菜单。消息始终提供“更多操作”入口，失败消息直接显示重试及取消重试。窄屏聊天使用动态视口高度和安全区，聊天记录搜索独占内容区，点击结果后进入原消息定位，关闭搜索可恢复聊天。

AI Copilot 分为回复、待办、记忆三个入口，待确认操作保持可见，工具与执行轨迹收进默认折叠的执行详情。浏览器回归覆盖草稿与光标恢复、账号隔离、存储写入失败、会话筛选、面板切换、触屏消息操作和窄屏搜索定位；普通消息仍通过真实 MySQL/Redis 环境验证。

## 当前已知限制

- 登录使用 Redis token 白名单；重复登录会签发新 token 并使旧 token 失效，因此当前仍不是多设备并行在线模型。
- Agent stream 已支持 SSE `agent` 生命周期事件、`delta` 文本增量及最终结果；普通对话还会在正文生成后提取结构化建议和待确认动作，因此正文结束与请求完成可能有时间差。
- MySQL 使用自研迁移机制：启动时自动执行，也可通过 `pnpm --filter pomelo-chat-server db:migrate` 单独运行；已有 `schema_migrations` 记录和数据库迁移锁，未引入第三方 migration 框架。
- 忘记密码后的账号恢复、群聊已读成员列表尚未实现；桌面侧栏助手尚无写操作确认入口。
- 外部 MCP 写工具需要显式确认路径，自动 Agent 不直接暴露写工具。
- 前端生产构建存在 Vite chunk size warning，功能不受影响，但后续可做代码分包。

## 测试数据

QA 不依赖静态账号。每次运行创建 `qa_<runId>_*` 用户、好友关系和群聊数据，并在结束时清理；不要将 QA 连接串指向生产数据库。

## License

ISC

### 共享交互逻辑与依赖维护

音视频弹窗共用 `client/src/hooks/useCallController.ts`，由它处理邀请、接听、超时和幂等挂断；`useLiveKitCall.ts` 只管理媒体连接和轨道释放。取消后迟到的邀请会结束服务端通话，不再加入媒体。下一步建议和 Copilot 草稿统一经过聊天页按当前房间插入输入框，不使用全局插入事件。

依赖统一使用根目录 `pnpm-lock.yaml`；安装从工作区根目录执行 `pnpm install --frozen-lockfile`。已移除旧客户端锁文件、未使用的 React Refresh 插件、Router 5 类型包和 fs-extra 依赖。普通流式 Agent 的结构化提取仍负责生成待确认任务、草稿及记忆，保留该步骤；只读总结和建议请求继续跳过它。

### 共享限流、记忆契约与确认控件

HTTP、Agent 和工具统一使用 `server/src/infrastructure/rate-counter.ts` 原子计数，保留各自额度和 Redis 故障策略：HTTP 与 Agent 使用本地窗口降级，工具暂停执行。计数与过期在同一段 Lua 中完成，并修复没有 TTL 的旧计数键。

`memory-contracts.ts` 统一记忆提议、模型结构化结果及工具执行的字段约束；提议和执行仍分别校验。预加载查询最多 120 字符，避免长输入使记忆读取被参数校验拒绝。同一次 Agent 调用仅复用用户、规范化查询词和条数相同的记忆结果；失败不缓存，结果按副本返回，不跨请求或用户共享。

主 Agent 与事项整理共用 `model.ts` 的连接配置，分别保留温度及重试设置。Copilot 普通操作和所选待办操作共用 `ActionControls.tsx`，保留原有确认、取消、查询及显式重试路径。
