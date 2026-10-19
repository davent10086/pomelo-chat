# 后端加固与本地磁盘运维

附件继续存储在本地磁盘，不接入 S3 或云存储。多 Node 实例必须能访问同一套文件；
如果实例分布在不同主机且各自使用独立磁盘，目前不能当作共享附件服务部署。
Go 网关和 Worker 本身不持有附件，仍可独立扩容。

## 成员权限与事件处理

- `POST /api/chat/v1/group/remove_member` 接受 `{ groupId, userId }`，只有群主能移除他人。
  省略 `userId` 表示本人退群。群主不能通过此接口退出或移除自己；没有新增管理 UI。
- 成员删除在事务内锁定群记录；提交后发布 `pomelo:room:access` 事件并关闭对应连接。
  事件丢失时，实际投递聊天内容、历史和已读帧前仍会重新校验成员资格，空闲连接每 15 秒复查。
  Go 的发送 ACK 和错误响应只携带调用者的操作结果，写出前检查 JWT 与 Redis 会话，
  不再额外调用 Node 查询房间权限；写入事务中的权限校验保持不变。
- 消息写入在已有事务执行器上以共享锁复查房间权限，与成员删除互斥。
  等待房间事务的发送请求不能在成员删除提交后绕过检查；不额外占用连接池连接。
- Go 将消息/通知、控制事件、Worker 唤醒拆成独立 Redis 订阅连接。控制处理阻塞不再
  阻塞其他房间的数据订阅；有界队列过载断开慢连接，由客户端补齐历史。
- 上下线刷新只查询持有该联系人的用户，通过已有通知通道发送；新增
  `idx_friend_presence(user_id, owner_id)` 索引。普通会话撤销按用户索引定位连接。
- 大群聊天列表通知按 32 人一批执行 Redis pipeline，并在批次前检查租约。
  部分发布失败仍遵循至少一次语义，可重复投递，不会提前完成 Outbox。
- Go Worker 的唤醒每次先调度一个通道，抢到真实任务后再唤醒另一个通道；
  保留配置的最大并发、各通道定时扫描和租约恢复，减少低负载时多个通道同时空查。
  `pomelo_outbox_claim_scans_total` 与 `pomelo_outbox_empty_scans_total` 可用于观察扫描效率。
- Go 内部调用按操作记录 `pomelo_bridge_send_seconds`、`pomelo_bridge_authorize_seconds`
  等耗时直方图，`pomelo_socket_queue_wait_seconds` 记录连接队列等待。
  指标不含用户、房间、token 或消息正文，读取继续要求指标凭据。

## 故障与持续负载测试

```powershell
pnpm test:realtime
pnpm test:realtime:soak
# 可调整为更长时间；群内为不同账号，不是同账号复制连接。
$env:SOAK_SECONDS='300'
$env:SOAK_GROUP_MEMBERS='32'
pnpm test:realtime:soak
pnpm test:ops
```

默认故障测试持续 60 秒，4 对私聊，加 16 个群接收成员与 1 个群发送者；每个发送流
目标 2 条/秒，最多一个未完成发送，实际缺失的生成时隙记录在报告中，不用补发突发掩盖。
采用默认消息准入配置；仅 API fixture 额度提高、Worker 租约缩短为 6 秒以加快崩溃恢复。
依次杀死并重启 Worker、网关，再中断测试自身的 Redis 订阅连接。
报告保存在 `test-results/realtime-soak-*/report.json`，包括重试、调度落后、故障时间、
含恢复的接收延迟、重复写入和历史补齐审计；失败也写报告。它不是开环容量测试或生产 SLA。

四种组合回归还覆盖：未授权移除成员、已连接成员被移除、排队发送与成员删除的事务竞争、
成员移除后消息不泄露，以及无关账号不收到在线状态刷新。Go 集成测试会故意阻塞控制侧的
业务请求，同时验证另一条订阅仍能投递消息，并检查写出前的权限校验。

## Prometheus 告警

`ops/monitoring/prometheus.yml` 提供独立采集 Go 和 Node 指标的模板；按部署地址修改 targets。
将相同的 `METRICS_TOKEN` 放入配置引用的 `/run/secrets/pomelo_metrics_token` 文件，仅授予采集进程读取权限。
采集端必须能访问 Node 的内部监听地址；不要为采集指标将业务内部端口开放到公网。

`alerts.yml` 包含服务失联、必需订阅断开、积压年龄/数量、采样故障、投递失败、背压和备份过期
共 8 类告警。独立 Worker 不会因未启用网关订阅而误报。阈值是初始值，应结合实际负载调整。
模板只定义采集和规则，不会创建外部消息接收者；需要通知时由部署方配置 Alertmanager 路由。

```powershell
promtool check config ops/monitoring/prometheus.yml
promtool check rules ops/monitoring/alerts.yml
promtool test rules ops/monitoring/alerts.test.yml
```

Go `/internal/ready` 同时检查本角色订阅、Redis/MySQL，以及带服务凭据的 Node 依赖探测。
监控 token 未配置时指标端点关闭。Node 的 `BACKUP_STATUS_FILE` 指向备份成功状态文件后，
才启用 24 小时备份过期告警；未设置时不会对未启用备份的开发环境报警。

## 离线备份与恢复

工具备份 MySQL 数据与本地附件，生成每张表、每个文件的 SHA-256 和行数清单。
SQL 表使用一致性快照，时间统一为 UTC；附件没有跨进程事务，**运行前必须停止所有
Node 写入服务和 Go Worker**，停止后再传 `--offline`。该参数是操作方的离线声明，
工具不会自动停止生产服务，也不宣称提供在线一致性备份。

从项目根目录执行，读取 `server/.env` 的显式 `DB_*` 和 `UPLOAD_ROOT` 配置：

```powershell
node server/scripts/ops/backup-local.js create --output F:/pomelo-backups/snapshot-20261019 --offline
node server/scripts/ops/backup-local.js verify --input F:/pomelo-backups/snapshot-20261019
node server/scripts/ops/backup-local.js restore --input F:/pomelo-backups/snapshot-20261019 --database pomelo_restore_20261019 --uploads F:/pomelo-restores/20261019 --offline
```

输出目录必须是新目录，且不能位于上传目录内。未完成备份没有 `manifest.json`，不能恢复。
恢复要求全新的 `pomelo_restore_*` 数据库和附件目录，不覆盖源数据库或已有目录。
表结构由当前代码初始化，不执行备份中的 SQL；列结构必须兼容，之后逐表校验行数、外键、
文件校验和。失败的恢复目标留作排查，不会自动替换正在运行的数据库。

成功后，核对 `.restore-complete.json`，再由操作方设置 `DB_NAME` 和 `UPLOAD_ROOT` 指向新目标，
先启动 Node 完成初始化，再启动 Go。Redis 会话、在线租约和确认操作缓存不在备份范围内；
切换时使用新的 `REDIS_KEY_PREFIX`，让用户重新登录，不复用旧的授权或执行中缓存。

设置 `BACKUP_STATUS_FILE` 后，成功备份会原子更新仅含最近成功时间的状态文件，供指标采集。
备份包含聊天正文和密码哈希，工具校验完整性但不加密；存放在受控磁盘，并另行保留异盘副本。
`pnpm test:ops` 在独立数据库与临时目录演练完整恢复，并验证损坏、目录越界和覆盖保护。
