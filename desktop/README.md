# Windows 桌面客户端

## 安装与连接

下载或构建 `release/Pomelo-Chat-0.1.0-x64-Setup.exe`，安装后启动 Pomelo Chat。
首次启动填写服务器根地址，例如 `https://chat.example.com`，点击“测试连接”，再“保存并连接”。
应用从安装包读取页面，无需 Node.js、pnpm、Vite、MySQL 或 Redis；聊天、文件、AI 等功能需要可访问的服务端。
远程服务器要求 HTTPS/WSS，本机调试允许 `http://127.0.0.1:3000`。不填写 `/api/chat/v1` 路径。

登录页可选择“记住登录”。只保存系统加密后的会话凭据，不保存密码；服务端仍会检查有效期与撤销。
不勾选时关闭应用后需要重新登录。标题栏齿轮可查看服务器设置，退出登录后可切换服务器。
不同服务器使用独立 Chromium 存储分区，草稿和 IndexedDB 待发消息不会跨服务器混用。
普通聊天草稿在桌面端可跨重启保留，待发队列沿用已有幂等恢复；超过自动重试范围的消息需要手动重试。
主动退出账号会清理该账号的草稿、待发消息和已保存凭据。接收历史仍由服务端持久化并在联网后补拉。

## 构建安装包

在 Windows、Node.js 20+、pnpm 10 环境运行：

```powershell
pnpm install --frozen-lockfile
pnpm build:desktop
```

输出：`release/Pomelo-Chat-0.1.0-x64-Setup.exe`；免安装的完整程序目录位于 `release/win-unpacked/`。
请保留整个目录，不能只复制其中的 EXE。`desktop/renderer/` 与 `release/` 是生成产物，不提交 Git。
构建复用已安装的 Electron 运行时；首次构建还需联网下载 NSIS 等工具。GitHub 下载受限时，可在当前终端设置
`$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'` 后重试。
镜像下载仍使用打包工具提供的校验和。

当前生成未签名安装包，未实现自动更新。每次升级可运行新安装包，用户目录保留；卸载默认也保留用户数据。
公开分发前应配置自己的代码签名证书。默认不启用开机启动或关闭后后台驻留。

## 服务端部署

服务端单独部署：MySQL 8+、Redis、Node.js，以及按需部署的 LiveKit 和模型服务。
配置 `server/.env`，运行 `pnpm --filter pomelo-chat-server build`，再在服务端运行
`pnpm --filter pomelo-chat-server serve`。生产环境用进程管理工具运行，通过反向代理提供 HTTPS 和 WSS。
代理需要支持 WebSocket Upgrade，AI SSE 禁止代理缓冲，上传请求体上限应匹配服务端分片限制。

已有 `CORS_ORIGINS` 必须加入 `pomelo://app`，不能以 `null` 或 `*` 替代。示例：

```dotenv
CORS_ORIGINS=pomelo://app,http://localhost:5173
```

新版本 `/api/chat/v1/health` 返回公开的服务标识，用于连接测试；它不等同于数据库/Redis 深度健康检查。
附件依然经过登录与成员权限检查。模型密钥、数据库密码及 MCP 配置只保存在服务端。
文件存储、数据库备份、TLS 证书和公网 LiveKit/TURN 由部署方管理；本安装包不内置这些服务。

## 验证

```powershell
pnpm test:desktop
pnpm test:desktop:smoke
pnpm build:desktop
pnpm test:desktop:production
```

生产回归运行真实 `release/win-unpacked/Pomelo Chat.exe`，不启动 Vite。需要本地 MySQL/Redis 和创建测试数据库权限；
读取现有服务端配置后创建独立数据库、Redis 前缀、上传目录及两个客户端用户目录，完成后清理。
覆盖首次配置、真实登录/消息/附件、系统加密登录恢复、跨进程草稿与待发恢复、离线接收恢复及退出清理。
AI 生成响应使用固定 SSE 夹具，核对与确认通过实际桌面控件调用真实后端，不调用收费模型；
真实模型质量、真实安装向导、公网音视频仍需人工验收。
截图与日志输出到 `test-results/desktop-production/`。

## 开发模式

在项目根目录运行：

```powershell
pnpm install
# 终端 1：使用现有 MySQL、Redis、模型配置启动后端
pnpm dev:server
# 终端 2：自动启动 Vite 和 Electron
pnpm dev:desktop
```

主窗口登录后，右侧出现 AI 标签。点击展开 360px 宽、与主窗口等高的助手面板；折叠恢复 40×96px 标签。
拖动主窗口、助手标签或面板标题栏时，两个窗口一起移动。最大化为组合窗口预留助手空间。
开启“关联当前聊天”后，可总结主窗口选中的私聊/群聊并生成回复建议。
回复可复制；生成消息草稿后，侧栏显示收件人选择、正文编辑和发送核对卡，点击“确认发送”才向联系人或群聊发消息。底部“提问”按钮仅向 AI 提问。折叠不打断生成；主窗口最小化时助手隐藏，恢复后继续查看回答；关闭主窗口退出整个应用。

默认前端 `http://127.0.0.1:5173`，后端 `http://127.0.0.1:3000`。
如后端或端口不同，在桌面启动终端设置：

```powershell
$env:POMELO_SERVER_URL = 'http://127.0.0.1:3000'
$env:POMELO_DESKTOP_PORT = '5173'
pnpm dev:desktop
```

更换前端端口时，后端 `CORS_ORIGINS` 必须包含对应的 `http://127.0.0.1:<端口>`，并重启后端。
启动器遇到占用端口会报错，不复用其他 Vite 实例。首次安装/启动需要下载 Electron 运行时。
助手使用透明背景，作为主窗口的附属窗口显示，不在其他应用之上全局置顶。

```powershell
pnpm test:desktop        # 几何边界、IPC 数据校验、动画竞态
pnpm test:desktop:smoke  # 真正的双 Electron 窗口，模拟 HTTP AI，无需数据库/模型
```

冒烟测试使用 5188 和 5189 端口，截图输出到 `test-results/desktop/`。
人工验收：在实际 Windows 桌面检查拖动、焦点、透明边缘、多显示器、高 DPI，
并连接真实后端检查登录、聊天选择、权限拒绝和 AI 流式回复。

当前不提供托盘、自动更新、离线 AI 或其他软件的读取/控制能力。
