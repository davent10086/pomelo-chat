# Backend modular monolith

The backend runs in one Node.js process. HTTP, WebSocket, SSE, migrations and background
tasks keep their existing startup and shutdown behavior. Modules communicate through
ordinary function calls; this refactor introduces no additional services or databases.

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

## Compatibility and checks

Old `service`, `utils` and `model/db` imports are compatibility facades. New production code
uses the canonical module or infrastructure paths. HTTP paths, response envelopes, status
codes, WebSocket frames, SSE events and database migrations are unchanged.

Run `pnpm --filter pomelo-chat-server test:architecture`. The TypeScript AST check rejects
module-internal cross imports, transport dependencies in business code, writes to another
module's tables, SQL execution outside repositories, lower-layer reverse imports and module
cycles. It runs in CI and `test:all`.

Behavior regressions use actual isolated MySQL/Redis targets and deterministic model stubs.
Use `node server/scripts/run-isolated-tests.js backend`, `system`, `migrations` or `browser`.
Unit tests also exercise the boundary check itself, transaction rollback, password verification,
actor isolation, upload access, bounded fanout and socket backpressure.
