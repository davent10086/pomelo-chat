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

- MySQL via `mysql` pool in `server/src/model/db.ts`.
- Tables initialized on server start:
  - `user`
  - `friend_group`
  - `friend`
  - `group_chat`
  - `group_members`
  - `message`
  - `message_statistics`
  - `assistant_memory`
- Redis via `ioredis` in `server/src/utils/authenticate.ts`.
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
  - `POST /assistant/chat`
  - `POST /assistant/chat/stream`
  - `POST /assistant/next-steps`
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

- Orchestrator: `server/src/service/assistant/agent-orchestrator.ts`.
- LLM Agent: `server/src/service/assistant/agent.ts`.
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
- Write-class external tools require confirmation if configured in `writeTools`.

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

- `POST /assistant/chat/stream`: proxies provider SSE chunks.
- `POST /assistant/agent/stream`: emits Agent lifecycle events and final Agent result.

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
