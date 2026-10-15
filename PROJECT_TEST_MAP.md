# Pomelo Chat Project Test Map

Generated: 2026-07-21

## 1. Project Structure

- `client/`: React + Vite single page app for login, contacts, chat, media upload, audio/video call UI, and built-in AI assistant entry.
- `server/`: Express + TypeScript backend for auth, friends, groups, messages, files, RTC signaling, assistant proxy, LangChain Agent, and Pomelo MCP stdio server.
- `docs/`: static project notes.
- `qa/`: QA harness, Postman collection, Playwright spec, and test result artifacts generated for this audit.

## 2. Frontend Stack

- Framework: React 18, React Router 6, Vite 4.
- UI library: Ant Design 5, `@ant-design/icons`.
- Styling: Less + CSS modules.
- HTTP: Axios wrapper in `client/src/utils/request.ts`.
- WebSocket: custom reconnecting wrapper in `client/src/utils/websocket.ts`.
- Storage: typed `sessionStorage` wrapper in `client/src/utils/storage.ts`; optional encrypted remember-login data in localStorage.
- AI UI: `client/src/hooks/useAiAssistant.ts`, `client/src/components/AiAssistantCard`, `client/src/pages/chat/index.tsx`.

## 3. Backend Architecture

- Runtime: Node.js + Express + `express-ws`.
- Language: TypeScript via `ts-node` in dev and `tsc` build.
- Route root: `/api/chat/v1`.
- Main route modules:
  - `/auth`: register, login, logout, password reset, profile update, user notification WebSocket.
  - `/friend`: friend list, search, add friend, friend group, update friend metadata.
  - `/group`: group list, search, create, info, invite, join, member list.
  - `/message`: chat list and message WebSocket.
  - `/file`: chunk verify, upload, merge.
  - `/rtc`: audio/video signaling.
  - `/assistant`: non-stream chat, SSE chat, next steps, LangChain Agent, Agent SSE, Agent tools.

## 4. Database and State

- MySQL via `mysql` pool in `server/src/infrastructure/database.ts`.
- Tables initialized on server start:
  - `user`
  - `friend_group`
  - `friend`
  - `group_chat`
  - `group_members`
  - `message`
  - `message_statistics`
  - `assistant_memory`
- Redis via `ioredis` in `server/src/infrastructure/redis.ts`.
  - Token whitelist: `token:<username>`.
  - AI rate limits: `ai_rate:<userId>` and `ai_agent_rate:<userId>`.
- In-memory fallback maps:
  - AI rate limiting if Redis increments fail.
  - WebSocket room maps in message and notification services.

## 5. AI Interface

- Provider-compatible Chat Completions API.
- Environment:
  - `DEEPSEEK_API_KEY`
  - `DEEPSEEK_BASE_URL`
  - `DEEPSEEK_MODEL`
- Non-Agent endpoints:
- Agent endpoints:
  - `POST /assistant/agent`
  - `POST /assistant/agent/stream`
  - `GET /assistant/agent/tools`
  - `POST /assistant/agent/tools/call`
- Limits:
  - Input/message max length: 8000 chars.
  - Context max length: 20000 chars.
  - Rate limit: 20 requests/user/minute for AI and Agent.

## 6. Agent Architecture

- Orchestrator: `server/src/modules/assistant/agent-orchestrator.ts`.
- LLM Agent: `server/src/modules/assistant/agent.ts`.
- Agent roles:
  - `coordinator_agent`: request routing and result merge.
  - `chat_context_agent`: loads recent visible room messages.
  - `todo_agent`: extracts todo-like items.
  - `reply_agent`: prepares reply suggestions.
- Intent routing:
  - `chat`
  - `context`
  - `todo`
  - `reply`
  - `mixed`
- Agent trace and step data are returned to the frontend and displayed in the AI panel.

## 7. MCP Tools

Internal Pomelo tools:

- `get_recent_messages`
- `search_messages`
- `get_message_context`
- `list_my_tasks`
- `search_contacts`
- `search_groups`
- `extract_todos`
- `suggest_replies`
- `search_memory`
- `save_memory`
- `forget_memory`

External MCP:

- Configured from `MCP_SERVERS_JSON`.
- Supports stdio, SSE, and streamable HTTP MCP transports.
- Current live tool list included web search and Amap map/weather/route tools during QA.
- Existing read-only MCP servers remain compatible. Servers with `writeTools` must list read tools in `readTools`; writes require a string idempotency field in `idempotencyKeys` and user confirmation.

## 8. Message Protocol

HTTP:

- All JSON APIs return `{ code, data, message }`.
- HTTP status is usually 200 even for business errors.

Private/group chat WebSocket:

- URL: `/api/chat/v1/message/connect_chat?room=<room>&id=<userId>&type=<private|group>&token=<jwt>`.
- First payload: array of history messages.
- Client send payload:
  - `receiver_id`
  - `content`
  - `type`: `text`, `image`, `video`, or `file`
  - `fileSize`
  - `avatar`
- Server broadcast payload:
  - `sender_id`
  - `receiver_id`
  - `content`
  - `room`
  - `type`
  - `file_size`
  - `created_at`

Notification WebSocket:

- URL: `/api/chat/v1/auth/user_channel?username=<username>&token=<jwt>`.
- Used for friend list, group list, chat list, and RTC notifications.

AI SSE:

- `POST /assistant/agent/stream`: shared chat/summary SSE with lifecycle events, text deltas, resets and final Agent result.
- `POST /assistant/agent`: shared chat/reply-suggestion endpoint. Summaries and suggestions use `context.readOnly: true`, disabling model tools, memory reads and confirmation proposals. The old chat/next-steps routes were removed.

## 9. Authentication Flow

1. Register creates user and default friend group.
2. Login validates bcrypt or legacy MD5 hash, optionally upgrades legacy hash.
3. Login checks Redis token whitelist. Existing token blocks second login.
4. JWT is signed with `JWT_SECRET` and stored in Redis with a 14-day TTL.
5. Protected APIs require `Authorization: Bearer <token>`.
6. WebSocket auth verifies JWT and Redis whitelist.
7. Logout deletes `token:<username>` and marks friends offline.

## 10. Primary Test Surfaces

- Auth:
  - Missing/invalid token.
  - Single-session behavior vs multi-device requirement.
  - SQL injection login probes.
- Chat:
  - WebSocket connection auth.
  - Room authorization.
  - Text, rapid messages, emoji, markdown-like content, special chars.
  - Oversized message rejection.
- Group:
  - Create validation.
  - Invite validation and multi-row insert.
  - Missing/non-member group access.
- File:
  - Upload metadata validation.
  - Chunk size limit.
  - Merge missing chunk behavior.
  - Static media token protection.
- AI:
  - Normal answer.
  - Recent-message context.
  - 100-turn context injection.
  - SSE event delivery.
  - Prompt injection refusal.
  - Provider timeout/error behavior.
- Agent:
  - Intent routing.
  - Tool selection.
  - Trace accuracy.
  - No unintended writes without explicit memory instruction.
- MCP:
  - Tool schema validation.
  - User/room isolation.
  - External tool failures and quota failures.
- Performance:
  - 100 concurrent HTTP reads.
  - WebSocket burst delivery.
  - AI latency and rate-limit behavior.

## P0/P1 integrated regressions

- `qa/playwright/address-book.e2e.spec.ts`: real friend editing/group creation, contact filtering, group details and invitation entry, plus a delayed friend-detail response that must not replace the current selection. Data requests are owned by `useAddressBook`; tree, editor and group details own their presentation.
- The isolated Playwright backend uses a larger API request budget because all functional fixtures share one IP. This does not change production rate limits or establish capacity evidence.
- `server/scripts/test-db-migrations.js`: concurrent initialization on two pooled connections, then repeated migration; validates the MySQL lock and idempotent execution after splitting schema and migration ownership.
- `server/scripts/test-agent-stream.js`: normal streaming retains metadata extraction; read-only streaming performs no extra metadata request and creates no confirmation proposals.

- Reply suggestions share `client/src/hooks/useReplySuggestions.ts`: bounded context, local fallback, debounce, cancellation and stale-result suppression. Keyboard selection inserts the selected reply into the existing draft.
- Assistant session delegates task cards, memory management and confirm/query/cancel operations to dedicated hooks. Uncertain writes query the server without automatic resubmission; retry remains an explicit user operation, and task selection is preserved on the server.
- `qa/playwright/assistant-interactions.e2e.spec.ts` covers delayed suggestions after typing or cancellation, selected-task confirmation, duplicate UI operations, lost write responses, explicit retry, Agent action confirmation and memory deletion confirmation/cancellation.

- `server/scripts/test-system-integrity.js`: real isolated MySQL/Redis, registration races, duplicate contacts, transactional message sequence and ACK, outbox retry after Redis failure, attachment authorization and metadata recovery, paged history, read cursor monotonicity, legacy migration replay, session replacement/revocation, and RTC cancellation/timeout state.
- `qa/playwright/system-regressions.e2e.spec.ts`: real login, private chat delivery, AI suggestion insertion, room switching, deterministic streaming updates, and password change.
- `server/scripts/run-isolated-tests.js system|migrations|browser`: local runner creates and removes only its own test database; credentials come from `server/.env` without accessing business tables.
- CI runs migration, system, browser, existing regression suites, and both production builds. LiveKit media/device behavior and real LLM provider availability remain outside these deterministic regressions.

### 工具契约回归

`server/scripts/test-tool-contracts.js`（`test:tool-contracts`，纳入 `test:integration`）：Zod/JSON Schema 一致性、输入与输出校验、错误脱敏、不可访问目标与空结果区分、外部 MCP 分页及游标循环、原名和截断重名、远端嵌套参数契约、Redis 共享限流及故障拒绝执行。分页与远端调用使用模拟服务；限流使用真实 Redis 隔离键。

### 共享通话与聊天准备逻辑

`qa/playwright/helpers/chat.ts` 统一注册、登录、好友关系和房间准备；系统回归、恢复回归和真实聊天/通话测试复用它。`real-rtc.e2e.spec.ts` 使用真实 LiveKit 与浏览器虚拟摄像头/麦克风验证双向音视频、挂断后的连接释放、每端单次挂断请求，以及取消后迟到邀请的清理。相关测试通过 `pnpm test:real-rtc` 启用，需独立 LiveKit 服务。

### 共享基础逻辑与请求内记忆复用

`test-tool-contracts.js` 追加共享记忆规则在提议/执行入口的一致性、敏感内容拒绝、请求内并发读合并、不同用户/查询/条数/请求隔离、返回副本及失败重试；共享限流覆盖真实 Redis 并发预算和 TTL 修复，并注入离线场景验证本地窗口降级和工具拒绝执行。`test-agent-stream.js` 追加长输入预加载长度及模型公共配置和各入口参数覆盖验证。浏览器助手交互用例继续覆盖共用确认控件的选择、取消、不确定结果查询和显式重试。
