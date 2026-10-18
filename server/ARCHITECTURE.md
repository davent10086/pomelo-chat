# Backend modular monolith

The backend runs in one Node.js process. HTTP, WebSocket, SSE, migrations and background
tasks keep their existing startup and shutdown behavior. Modules communicate through
ordinary function calls; this refactor introduces no additional services or databases.

`infrastructure/database.ts` owns connection configuration, the pool and test-target guards.
`infrastructure/database/schema.ts` holds table definitions in foreign-key order, while
`infrastructure/database/migrations.ts` executes schema changes and historical repairs.
Each initialization owns its connection and holds the existing MySQL migration lock through
completion; concurrent initialization in one process is serialized without shared connection state.

## Ownership

| Module | Responsibility | Owned database tables |
| --- | --- | --- |
| identity | Users, passwords, JWT and session verification | user |
| social | Contacts, friend groups, groups, membership and room access | friend, friend_group, group_chat, group_members |
| messaging | Messages, conversations, read cursors, attachment references and outbox | message, conversation, conversation_read, message_statistics, message_attachment, message_outbox |
| files | Upload sessions, filesystem operations, metadata and ownership | file_metadata |
| rtc | Call state, transitions, participant rules and LiveKit integration | Redis call state |
| assistant | Main Agent, tool preprocessing, confirmation actions, tasks, memory and MCP | assistant_action, assistant_task, assistant_memory, mcp_audit_log |
| realtime | Socket registration, presence leases, session invalidation and frame delivery | Redis presence state |

`infrastructure` owns MySQL/Redis clients, transaction execution and HTTP result serialization.
`shared` contains identity/transaction/result contracts and business-independent utilities.
`read-models` contains cross-module projections, including chat summaries, member activity,
message author profiles, notification recipients and attachment visibility. Read models may
join tables without composing many separate queries; they never perform business writes.

## Calls and adapters

- Import another module through `public.ts` or `contracts.ts`, never its implementation files.
- Business use cases take actor identities and explicit input DTOs. They return `Outcome`
  values containing the existing business code and data. They never receive Express objects.
- HTTP adapters select body/query/path inputs and serialize outcomes. SSE adapters own
  response headers, event framing and disconnect listeners; the Agent receives callbacks
  and `AbortSignal`. Realtime adapters own WebSocket objects and buffers.
- SQL execution lives in module repositories and read models. Services do not accept arbitrary
  SQL. Dynamic query fragments originate only from validated, server-controlled filters.
- `composition.ts` constructs application factories with explicit capabilities. For example,
  identity receives default-group initialization and call cleanup; social receives initial-message
  creation and notification delivery; RTC receives its call store and notification delivery.
  No dependency container or global service registry is used.

The business dependency direction is assistant/realtime → messaging/social/identity → files.
RTC uses social membership. Composition injects callbacks where a direct import would create
a reverse edge; module dependency cycles are rejected by the architecture check.

## Transactions and delivery

Cross-module transactional operations receive the caller's `SqlQuery` executor. They must not
start another transaction or use the global pool. User registration and default friend group
creation are atomic. Group creation and its initial message are atomic. Message insertion,
sequence advancement, statistics, attachment reference and outbox insertion are atomic.

Files validates and locks owned metadata; messaging writes the attachment reference using
the same executor. Notifications occur after commit. Existing action claims, leases, idempotency,
room authorization, outbox recovery and socket revocation are preserved.

Delivery remains at least once; clients merge by message ID. Socket session checks remain
active, and slow sockets reconnect and recover persisted history. The main Agent still uses
parallel deterministic preprocessing, with writes requiring explicit user confirmation.

## Entry points and checks

The old `service`, `utils` and `model/db` facades have been removed. Production code, scripts
and tests use module APIs, shared utilities, infrastructure or the composition root directly.
The architecture check rejects compatibility imports from every backend layer.

AI chat, summaries and reply suggestions share `/assistant/agent` and `/assistant/agent/stream`.
The old `/assistant/chat`, `/assistant/chat/stream` and `/assistant/next-steps` routes have been
removed; clients must migrate with the backend. The non-streaming chat fallback has also been
removed. Summary and suggestion clients pass `context.readOnly: true`: the main Agent has no
model tools, loads no long-term memory and creates no confirmation proposals. Deterministic
preprocessing remains available. Normal Agent chat retains explicit confirmation for writes.
Read-only streams return text without a second metadata-extraction model call. Normal streaming
chat still extracts structured suggestions and confirmation proposals; non-streaming read-only
suggestions retain their structured response. `agent-response.ts` owns response schemas, parsing,
sanitization and presentation, while `agent.ts` owns execution and action proposal orchestration.
Both streaming clients use the same SSE parser for lifecycle events, delta resets and final results.
Message overload uses HTTP 429 with Retry-After and a retryable WebSocket error carrying
the original client message ID and retry delay. Other business response contracts are preserved.

Message admission atomically consumes user, room and global Redis token buckets before new
transactional writes. Process-local queues bound waiting work; sampled Outbox pressure rejects
new work when pending counts or age exceed configured thresholds. These sampled limits are
soft gates, not durable capacity reservations. Redis admission failures reject new writes;
committed idempotent retries can still resolve. Confirmed assistant messages use the same queue.
Clients retain their message IDs and apply bounded backoff when admission is refused.

The Outbox worker preserves flush requests received during an in-flight drain, avoiding a lost
wakeup that would otherwise delay new messages until the next poll. Delivery receipts bind a
single-use challenge to the receiving socket; they measure client parsing, separately from
user read cursors. Receipt state has fixed bounds and expiry. The opt-in /internal/metrics
endpoint requires METRICS_TOKEN as a bearer token; metrics contain no user or room labels.
Operational defaults are documented in ../README.md and server/.env.example.

Run `pnpm --filter pomelo-chat-server test:architecture`. The TypeScript AST check rejects
module-internal cross imports, transport dependencies in business code, writes to another
module's tables, SQL execution outside repositories, lower-layer reverse imports and module
cycles. It runs in CI and `test:all`.

Behavior regressions use actual isolated MySQL/Redis targets and deterministic model stubs.
Use `node server/scripts/run-isolated-tests.js backend`, `system`, `migrations` or `browser`.
Unit tests also exercise the boundary check itself, transaction rollback, password verification,
actor isolation, upload access, bounded fanout and socket backpressure.

## Real chat path

Run `pnpm test:real-chat` from the repository root. This starts the real backend and Vite
frontend on ports 3199 and 5199, and runs two Chromium clients without HTTP response stubs
or WebSocket interception. It verifies browser login, persisted messages and ACKs, notification
delivery, browser upload/merge, byte-for-byte recipient download, outsider denial, and history
recovery without duplicates after the receiver disconnects and reloads. No model is called.

Private read receipts use the existing persisted read cursor. A successful authorized read
updates the cursor monotonically, then the HTTP adapter invokes a delivery callback supplied
by composition. Local sockets and Redis fanout receive a `read_receipt` frame; private history
includes `peerReadSeq` so refresh and reconnect restore the same state. The client shows one
check for a sent message and two blue checks after the peer reads it. The real-chat browser
test covers the transition, sender refresh and reading messages received while offline.
Group chats retain unread counts and read cursors without a reader list or double checks.

The local runner creates a uniquely named MySQL test database, Redis key prefix and temporary
upload directory, then cleans them after the browser servers exit. Configure `REDIS_URL_TEST`
for your local Redis (for example `redis://[::1]:6379/15` for an IPv6-only listener). MySQL
credentials come from the existing server environment. Production uploads still default to
`server/uploads`; `UPLOAD_ROOT` changes physical storage without changing attachment URLs.

`pnpm test:real-rtc` additionally requires a running LiveKit server (tested version 1.13.9).
It exercises private audio and video invitations, acceptance, actual bidirectional RTP reception,
decoded video dimensions, and peer connection shutdown in two Chromium contexts. Browser media
devices are synthetic, but no HTTP, signaling or WebRTC response is stubbed. Media diagnostics
are attached on failures. This optional test is excluded from the default browser suite because
that suite does not start LiveKit; it does not establish public-network NAT/TURN or group-call coverage.
