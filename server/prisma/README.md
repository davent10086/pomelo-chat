# Prisma 数据访问

使用 Prisma 7.10.1、MySQL provider 和官方 `@prisma/adapter-mariadb`。驱动名称不代表数据库改为 MariaDB；现有 MySQL 数据保留。

- `schema.prisma` 从独立测试库执行现有完整迁移后反向生成，保留 17 张表的字段、类型、索引及关系。
- 用户 repository、部分文件查询及房间权限查询使用 Prisma 模型 API。复杂投影、原子 upsert、消息序号锁和 Outbox 抢占仍使用参数化 SQL，经同一 Prisma Client 执行。
- `SqlQuery` 与 Prisma transaction client 绑定；跨模块操作共享同一事务。事务内不能改用全局客户端，否则会破坏原子性。
- SQL 兼容层将 `?`、列表、批量 VALUES 和 SET 对象转换为绑定参数，不拼接用户值。保留给自定义 executor 的 SQL 回退用于测试/适配边界，生产 executor 绑定 Prisma。
- BIGINT 在 API 边界转换为安全整数，超出安全范围时拒绝隐式舍入。保留自增 ID 和重复键/死锁错误契约，只有明确回滚的事务可以重试。
- 时间字段保留原 mysql2 的进程本地时区解释；绑定的 Date 参数和返回的 Date 均通过兼容层转换。多实例应统一进程时区。全量改为 UTC 或调整旧数据应另做迁移，不能直接改变本次的时间语义。
- 时间默认值使用 `@default(dbgenerated("CURRENT_TIMESTAMP"))`，由数据库生成，避免 Prisma 注入 UTC 时间改变旧行为。重新 introspect 后需保留此声明，并运行 `test:prisma` 验证；这项声明不修改现有表结构。
- Prisma 业务连接池上限为 10，连接与获取连接期限为 5 秒，socket 无响应期限为 10 秒；事务等待为 5 秒、执行为 15 秒。这些期限不等于服务器端查询被强制终止。
- mysql2 连接池仅用于旧迁移器和测试夹具；`closeDatabase()` 同时关闭两个连接池。

## 命令

在项目根目录运行：

```powershell
pnpm --filter pomelo-chat-server prisma:generate
pnpm --filter pomelo-chat-server prisma:validate
node server/scripts/run-isolated-tests.js prisma
```

`pnpm install` 会生成客户端；部署构建目录前必须执行完整构建。开发/CI 支持 Node.js 20.19+、22.12+ 或 24+。schema 变更后需要重新生成。

## 表结构升级只有一个入口

当前 `db:migrate` 是唯一的结构升级入口，继续使用现有 migration lock、版本记录和兼容性数据修复。**不要运行 `prisma migrate dev`、`migrate reset` 或 `db push` 接管现有库。** schema 的作用是描述当前结构并生成查询客户端，尚未建立 Prisma Migrate baseline。

新增字段/索引时，先修改并测试原迁移器，在独立测试库应用后用 `prisma:pull` 更新模型，再 generate。`prisma:pull` 读取 CLI 配置目标的结构；执行前确认目标和环境。模型文件不包含数据库密码，生成目录已被 Git 忽略。

配置优先级为测试 URL、`DATABASE_URL`、`DB_*`/旧 config.json、默认值。URL 使用 mysql 协议和基本连接字段；本次不新增 TLS/Unix socket 参数配置。不要将生产连接串写进仓库。
