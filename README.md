# Pomelo Chat

Pomelo Chat 是一个基于 WebSocket 和 HTTP 的实时聊天应用，支持用户认证、好友管理、群组聊天、文件传输和音视频通信功能。

## 功能特性

- 用户注册与登录（JWT 认证）
- 好友添加与通讯录管理
- 单聊与群聊消息实时通信
- 文件上传与下载
- 音视频通话信令支持
- 消息持久化存储（MySQL）
- Redis 缓存会话与通知
 - AI 辅助交互（实验性）：输入补全（Tab 补全）、对话摘要与建议面板（前端优先调用第三方 AI，支持本地回退）

## 技术架构

### 前端

- React + TypeScript
- Vite 构建工具
- Ant Design 组件库
- React Router 路由管理

### 后端

- Node.js + Express
- WebSocket: express-ws
- 数据库: MySQL
- 缓存/消息: Redis (ioredis)
- 身份认证: JWT (jsonwebtoken)
- 文件处理: Multer + fs-extra

## 目录结构

```
.
├── client/          # 前端代码
│   ├── src/
│   │   ├── assets/     # 静态资源
│   │   ├── components/ # 组件
│   │   ├── pages/      # 页面
│   │   ├── router/     # 路由配置
│   │   ├── utils/      # 工具函数
│   │   └── ...
│   └── ...
# Pomelo Chat（项目说明）

Pomelo Chat 是一个开源的即时通讯演示项目，使用 WebSocket 与 HTTP 提供实时聊天能力，包含用户认证、好友管理、单聊/群聊、文件上传下载与基本的音视频通话信令支持。该仓库分为 `client`（前端）和 `server`（后端）两个子项目，便于本地开发与部署。

本 README 旨在让开发者快速上手、理解项目结构与运行流程，并包含常见配置与调试建议。

## 主要特性

- 注册/登录（JWT）
- 好友与通讯录管理
- 单聊/群聊实时消息（基于 WebSocket）
- 文件上传/下载（支持大文件）
- 音视频通话信令（RTS/RTC 相关接口）
- 消息持久化（MySQL）与 Redis 缓存/通知

## 技术栈

- 前端：React + TypeScript + Vite + Ant Design
- 后端：Node.js + Express + express-ws
- 数据库：MySQL
- 缓存/消息：Redis (ioredis)
- 认证：JWT (jsonwebtoken)
- 其它：Multer（文件上传）、fs-extra、uuid

## 仓库结构（概要）

```
.
├── client/          # 前端应用（React + TypeScript + Vite）
│   ├── src/         # 源码
│   └── package.json
├── server/          # 后端服务（Node + Express）
│   ├── src/         # 源码
│   └── package.json
├── package.json     # 根目录脚本与工具配置
└── README.md
```

## 环境要求

- Node.js (建议 v16+)
- pnpm / npm
- MySQL（用于持久化消息与用户数据）
- Redis（可选但推荐，用于缓存、通知推送等）

## 快速开始（本地开发）

下面的命令基于你已安装 Node.js 与 pnpm/npm。

1. 克隆仓库并进入目录

```powershell
git clone <repository-url>
cd pomelo-chat
```

2. 安装依赖

```powershell
# 根目录依赖（用于格式化/lint 等）
npm install

# 前端依赖
cd client
npm install

# 后端依赖
cd ../server
npm install
```

3. 配置数据库

- 在 `server/src/model/config.json` 中填写你的 MySQL 配置：

```json
{
  "host": "127.0.0.1",
  "port": 3306,
  "user": "root",
  "password": "123456",
  "database": "pomelo-chat"
}
```

4. 启动后端服务

```powershell
cd server
npm start
```

后端默认监听端口：3000（也可以通过设置环境变量 `PORT` 覆盖）。

5. 启动前端开发服务器

```powershell
cd client
npm run dev
```

前端默认由 Vite 启动（开发服务器通常运行在 http://localhost:5173，并会自动打开浏览器，参见 `client/vite.config.ts`）。

前端与后端默认的接口地址在 `client/src/config/index.ts` 中配置为 `http://127.0.0.1:3000`（HTTP）和 `ws://127.0.0.1:3000`（WebSocket）。如果你更改后端端口，请同步更新该文件或使用代理。

## 常用脚本

- 根目录：
  - `npm run start` -（根目录通常用于运行工具脚本）
  - `npm run eslint` / `npm run prettier`

- 前端（client）：
  - `npm run dev` - 启动开发服务器（等同于 `pnpm run dev`）
  - `npm run build` - 构建生产包（会先运行 `tsc`）
  - `npm run preview` - 预览构建产物

- 后端（server）：
  - `npm start` - 使用 nodemon 启动后端（自动重启）

## 主要配置点

- `server/src/model/config.json` - MySQL 数据库连接配置
- 环境变量：
  - `PORT`：后端监听端口（默认 3000）
  - `JWT_SECRET`：JWT 签名的密钥（建议在生产环境通过环境变量注入）
  - `REDIS_HOST` / `REDIS_PORT`：Redis 地址与端口

## 文件上传限制

后端已配置对 WebSocket 的最大 payload（在 `server/src/index.js` 中），并在服务端对大文件做了支持（5GB）。在生产部署时，请确保你的反向代理（如 Nginx）和进程管理工具也允许足够的请求体大小与超时设置。

## API 概览

后端 REST API 前缀为 `/api/chat/v1`。常见路由：

- `/api/chat/v1/auth` - 用户认证相关
- `/api/chat/v1/friend` - 好友管理
- `/api/chat/v1/message` - 消息相关
- `/api/chat/v1/group` - 群组管理
- `/api/chat/v1/rtc` - 音视频通话信令
- `/api/chat/v1/file` - 文件上传/下载

具体接口与请求示例建议整理到单独的 API 文档（可使用 Postman 或 Swagger/OpenAPI 描述）。

## 开发建议与调试

- 本地开发：推荐先启动后端再启动前端，以保证 API 与 WebSocket 服务可用。
- 当你修改后端配置（如端口），需要同步更新 `client/src/config/index.ts` 中的 `apiBaseURL` 与 `wsBaseURL`。
- 建议在开发环境增加 dotenv 支持（例如使用 `dotenv` 加载 `.env` 文件），避免将敏感信息写死在源码中。

## AI 交互（实验性）

项目在前端实现了部分 AI 交互辅助功能（实验性质），用于提升聊天输入的体验与对话摘要。该功能为客户端侧实现，依赖第三方 AI 接口或本地启发式回退。请谨慎在生产环境直接启用。以下为实现说明、配置与已知缺陷：

### 已实现的功能

- Tab 补全：在聊天输入框中按 Tab 会触发候选补全建议（基于当前输入与会话上下文），用户可用上下箭头/鼠标选择并插入建议。
- 建议面板：显示多项候选建议、预览与高亮选中项，支持点击插入。
- 对话摘要（AIChatSummary）：基于会话历史生成对话摘要/主题提示，展示在侧边或摘要面板中，帮助快速了解会话要点。
- DeepSeek API 与本地回退：前端优先调用配置的 DeepSeek（或其他）AI 接口获取候选，若不可用则使用客户端的启发式规则作为回退。

### 配置与环境变量

- 前端会从环境变量读取 AI 服务的 Key（示例）：`VITE_DEEPSEEK_API_KEY`。
- 为防止泄露，强烈建议不要把第三方 API Key 嵌入前端代码；生产环境应通过后端代理或服务端中转来调用 AI 服务。

示例 `.env`（放在 `client/` 或在构建时注入）：

```
VITE_DEEPSEEK_API_KEY=your_deepseek_api_key_here
VITE_DEEPSEEK_ENDPOINT=https://api.deepseek.example/v1
```

如果选择后端代理，建议：

- 在 `server` 中增加一个受限的代理接口（仅用于 AI 补全），并在服务端安全地存储 API Key；
- 后端实现速率限制、鉴权与日志脱敏（避免记录敏感对话原文）。

### 隐私与安全提醒

- 任何发送到第三方 AI 服务的对话上下文都有被第三方存储/处理的风险。生产环境中请获得用户明确授权并尽量对敏感字段进行脱敏。
- 切勿在前端源码或公共仓库中暴露 API Key；使用后端代理或密钥注入服务来保护凭据。

### 前端行为与错误处理

- 若 AI 服务调用失败，前端会回退为本地启发式建议（并在控制台/日志中记录错误）。
- 网络延迟或超时会导致建议加载变慢；UI 会显示加载指示器。
- 当前实现为非流式（一次性返回候选），若需要更接近人类交互的流式体验，需要后端支持流式接口或前端使用 SSE/WebSocket 从代理接收增量数据。

### 已知缺陷与限制（重要）

1. Key 管理：当前示例使用前端环境变量直接调用第三方 API，存在泄露风险（必须通过后端代理解决）。
2. 模型输出不稳定：AI 可能会出现“幻觉”（错误或不一致的内容），建议在关键操作前进行校验或添加人工确认步骤。
3. 无流式响应：目前补全与摘要为一次性返回，用户体验不如流式返回（无法看到增量生成）。
4. 隐私审查缺失：没有在发送到 AI 服务前做敏感信息过滤或脱敏处理。
5. 异常与速率控制：后端没有默认为 AI 调用实现速率限制或错误重试策略（易受滥用或网络波动影响）。
6. 测试覆盖不足：与 AI 交互相关的单元/集成测试、模拟与端到端测试尚未完善。
7. 移动端与无障碍：建议面板在小屏幕或使用辅助功能时的表现尚需优化。

### 改进建议（优先级排序）

1. 后端代理：把所有第三方 AI 调用移到后端；后端负责密钥管理、鉴权、速率限制与日志脱敏。
2. 支持流式响应：在代理层实现流式转发（SSE / WebSocket），前端实现渐进式渲染，提升 UX。
3. 隐私过滤器：在发送前对敏感字段做脱敏（如身份证、银行卡、密码）或提供“仅发送必要上下文”开关。
4. 干预与人工确认：对重要/破坏性建议加入人工确认流程或撤销操作。
5. 增加测试：编写覆盖 AI 接口的单元测试与端到端测试（可用 mock 服务替代真实 API）。
6. 配额与计费监控：在后端增加调用计数、告警与超额熔断策略，防止滥用导致高额费用。
7. 移动端/无障碍优化：优化建议面板布局、键盘导航以及屏幕阅读器支持。

> 备注：AI 功能当前为实验性实现，仅作为开发参考与 UX 原型。将此功能用于生产前，请先实现后端代理、隐私保护和测试覆盖。

## 部署（简要）

1. 在 CI 环境或服务器上构建前端：

```powershell
cd client
npm run build
```

2. 将构建产物放到静态服务器或通过反向代理（Nginx）托管；或将 `client/dist` 与后端联合部署。

3. 在生产服务器配置 MySQL 与 Redis，设置环境变量（`PORT`, `JWT_SECRET`, `REDIS_HOST`, `REDIS_PORT` 等）。

4. 使用进程管理工具（如 PM2）启动后端：

```powershell
cd server
pm2 start src/index.js --name pomelo-chat
```

注意：确保反向代理/负载均衡与 Node.js 进程的超时、请求体大小、WebSocket 转发配置已正确设置。

## 测试与质量保障

- 代码风格：ESLint + Prettier
- 提交规范：项目根目录包含 `commitlint.config.js`，建议在团队中启用规范化提交（例如 Husky + lint-staged）。

## 后续文档建议（待补充）

1. API 文档（Postman 集合或 OpenAPI）
2. 数据库表结构与初始化脚本
3. 部署示例（使用 Docker / docker-compose）
4. 测试与 CI 配置示例

## 贡献

欢迎提交 issue 或 PR。提 PR 时请遵循代码风格并提供变更说明与相关测试。

## 许可证

MIT
