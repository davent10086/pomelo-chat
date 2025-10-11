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
├── server/          # 后端代码
│   ├── src/
│   │   ├── controller/ # 控制器
│   │   ├── model/      # 数据模型
│   │   ├── service/    # 业务逻辑
│   │   └── utils/      # 工具函数
│   └── ...
└── ...
```

## 环境要求

- Node.js (推荐 v16.x 或更高版本)
- MySQL 数据库
- Redis 服务
- npm 或 pnpm 包管理器

## 快速开始

### 1. 克隆项目

```bash
git clone <repository-url>
cd pomelo-chat
```

### 2. 数据库配置

1. 创建 MySQL 数据库
2. 修改 [server/src/model/config.json](file:///f%3A/Pomelo%20Chat/server/src/model/config.json) 中的数据库配置：

```json
{
  "host": "127.0.0.1",
  "port": 3306,
  "user": "root",
  "password": "123456",
  "database": "pomelo-chat"
}
```

### 3. 安装依赖

```bash
# 安装根目录依赖
npm install

# 安装前端依赖
cd client
npm install

# 安装后端依赖
cd ../server
npm install
```

### 4. 启动服务

```bash
# 启动后端服务
cd server
npm start

# 启动前端开发服务器
cd client
npm run dev
```

默认情况下：
- 后端服务运行在 http://localhost:3000
- 前端开发服务器运行在 http://localhost:5173

## 项目配置

### 环境变量

后端服务可能需要配置以下环境变量：

- `PORT`: 服务端口，默认为 3000
- `JWT_SECRET`: JWT 加密密钥
- `REDIS_HOST`: Redis 主机地址，默认为 localhost
- `REDIS_PORT`: Redis 端口，默认为 6379

### 文件上传

项目支持大文件上传，最大支持 5GB 文件上传和 100MB 请求体。

## API 接口

API 接口遵循 RESTful 风格，统一前缀为 `/api/chat/v1/`。

主要模块：
- `/api/chat/v1/auth` - 用户认证
- `/api/chat/v1/friend` - 好友管理
- `/api/chat/v1/message` - 消息处理
- `/api/chat/v1/group` - 群组管理
- `/api/chat/v1/rtc` - 实时通信
- `/api/chat/v1/file` - 文件处理

## 部署

### 构建前端

```bash
cd client
npm run build
```

构建产物将生成在 `client/dist` 目录中。

### 生产环境部署

1. 构建前端应用
2. 配置生产环境数据库和 Redis
3. 设置环境变量
4. 使用 PM2 或其他进程管理工具启动后端服务：

```bash
cd server
pm2 start src/index.js --name pomelo-chat
```

## 开发指南

### 代码规范

- 使用 ESLint 和 Prettier 进行代码格式化
- 遵循 commitlint 提交信息规范
- 前后端分离架构，通过 API 进行通信

### 目录规范

#### 前端目录结构
- `src/components/`: 可复用 UI 组件
- `src/pages/`: 页面级组件
- `src/router/`: 路由配置
- `src/service/`: 服务调用逻辑
- `src/utils/`: 工具函数
- `src/config/`: 应用配置

#### 后端目录结构
- `src/controller/`: 请求控制器
- `src/service/`: 业务逻辑层
- `src/model/`: 数据模型
- `src/utils/`: 工具函数

## 许可证

[MIT](LICENSE)