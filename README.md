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

前端会在运行时根据“当前页面的主机名 + :3000”自动拼接后端地址（HTTP 与 WebSocket），例如你通过 `http://192.168.1.10:5173` 打开前端，则默认会请求 `http://192.168.1.10:3000` 与 `ws://192.168.1.10:3000`。也可以通过环境变量覆盖：`VITE_API_BASE`、`VITE_WS_BASE`、`VITE_SERVER_URL`。

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
- 当你修改后端端口（默认为 3000），前端会自动拼接当前主机名 + 端口；如需指定固定地址，可通过环境变量 `VITE_API_BASE`、`VITE_WS_BASE` 覆盖。
- 建议在开发环境增加 dotenv 支持（例如使用 `dotenv` 加载 `.env` 文件），避免将敏感信息写死在源码中。

### 局域网调试（两台设备同时运行）

你可以在同一 Wi‑Fi/局域网内，用“手机/另一台电脑”访问你的开发机，做到两端同时登录并互相收发消息。

1) 服务端监听 0.0.0.0（已内置）

- `server/src/index.js` 使用 `app.listen(port, '0.0.0.0')`，允许局域网其他设备访问。

2) 前端开发服务器绑定 0.0.0.0（已内置）

- `client/vite.config.ts` 设置 `server.host = '0.0.0.0'`，同网段设备可访问 Vite：`http://<你的开发机IP>:5173`

3) 前端自动拼接后端地址（已内置）

- `client/src/config/index.ts` 会根据“当前页面的主机名 + :3000”拼接 API 与 WS 地址；因此你在手机访问 `http://<开发机IP>:5173` 时，前端会自动请求 `http://<开发机IP>:3000` 与 `ws://<开发机IP>:3000`。
- 如需固定地址，可在 `client/.env` 配置：

```env
VITE_API_BASE=http://192.168.1.10:3000/api/chat/v1
VITE_WS_BASE=ws://192.168.1.10:3000/api/chat/v1
VITE_SERVER_URL=http://192.168.1.10:3000
```

4) 找到你的开发机局域网 IP

- Windows PowerShell 执行：`ipconfig`，选用带网关、可被同网段访问的网卡（常见为 WLAN/wifi）。例如 `IPv4 地址 10.102.38.188`。

5) 在另一台设备上访问

- 浏览器打开：`http://<开发机IP>:5173`
- 登录同一账号/进入同一房间，即可互发消息验证同步。

提示：若出现无法访问，优先检查 Windows 防火墙是否允许 5173/3000 入站；企业 Wi‑Fi 可能启用 AP 隔离，可改用手机热点或家庭路由测试。

## AI 交互（实验性）

项目在前端实现了部分 AI 交互辅助功能（实验性质），用于提升聊天输入的体验与对话摘要。该功能为客户端侧实现，依赖第三方 AI 接口或本地启发式回退。请谨慎在生产环境直接启用。以下为实现说明、配置与已知缺陷：

### 已实现的功能

- 候选回复与快捷插入
  - Tab 补全：在输入框按 Tab 触发候选回复；上下箭头/鼠标选择，Enter/→ 接受，Esc 关闭。
  - 建议面板：显示多项候选、可点击插入；支持“关闭/隐藏”按钮，不打扰输入区域。
- 下一步建议（浮动气泡）
  - 将“下一步建议”以浮动卡片的形式展示在聊天区域左下角（非输入区），避免压缩输入框视野。
  - 点击芯片后会通过自定义事件把文本插入到输入框光标处（事件名：`next-steps-insert`）。
- 对话摘要（流式输出 + 可中断）
  - 组件：`client/src/components/AIChatSummary/index.tsx`
  - 通过类 SSE 方式流式解析与渲染，并支持 AbortController 取消；在流式不可用时自动回退到一次性返回。
  - 确保最终文本交付：使用 ref 规避闭包时序带来的丢句问题。
- DeepSeek API 与本地回退：优先调用配置的 DeepSeek（或其他）AI 接口；失败时使用启发式本地候选以兜底。

### 配置与环境变量

- 前端直连（开发/本地演示用）：
  - `VITE_DEEPSEEK_API_KEY`（不推荐用于生产）
  - `VITE_DEEPSEEK_ENDPOINT`（可选）
- 推荐：后端代理（生产）
  - 不要在前端打包任何第三方 API Key。
  - 在 `server` 增加 AI 代理路由，服务端安全保存 Key，并实现鉴权/限流。
  - 前端仅调用受控的代理接口，例如 `/api/ai/completions`、`/api/ai/summary`。

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

- 对话摘要为“流式输出”：逐步渲染增量文本，支持“取消”操作；当流式不可用时自动回退到非流式。
- 候选回复目前为“非流式”：一次性返回候选；如需流式建议建议通过后端代理提供 SSE/WebSocket 能力。
- 调用失败回退：AI 服务失败时，前端回退到本地启发式规则；在控制台记录错误。
- 超时与网络：慢链路可能导致加载延迟；UI 显示加载指示与可取消态。
- 插入机制：下一步建议通过自定义事件把文本插入输入框；候选面板支持关闭以减少干扰。

### 已知缺陷与限制（重要）

1. Key 管理：如使用前端直连，存在密钥泄露风险（生产必须改为后端代理）。
2. 模型输出不稳定：可能出现“幻觉”；关键操作前建议校验或二次确认。
3. 候选回复非流式：候选目前一次性返回，无法呈现增量生成过程。
4. 隐私过滤缺失：发送前未做系统性的敏感信息脱敏与审核。
5. 异常与速率控制：代理未内置完善的限流/重试（建议在后端实现）。
6. 测试覆盖不足：与 AI 交互相关的单测/集测/E2E 仍需完善。
7. 移动端与无障碍：浮动建议与面板在小屏/读屏器下仍需优化。

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
