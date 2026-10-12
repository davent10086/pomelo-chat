# Windows 桌面开发原型

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
回复可复制，本原型不提供写操作确认入口。折叠不打断生成；主窗口最小化时助手隐藏，恢复后继续查看回答；关闭主窗口退出整个应用。

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

这是开发原型，没有安装包、托盘、自动更新、离线 AI 或其他软件的读取/控制能力。
