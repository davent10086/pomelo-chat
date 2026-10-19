# Go realtime gateway and Outbox

The root launcher starts Go as the public HTTP/WebSocket entry point and Node.js as
the private business service. AI and SQL business transactions remain in Node.js.
The Go module requires Go 1.26+; its pinned dependencies and checksums live in
`services/realtime`. Database migrations are still run only by Node.js.

## Start and configure

Use `pnpm dev:server` (or `pnpm start`) after configuring `server/.env`. The launcher
builds Go, starts Node.js, waits for database migration and HTTP health, then starts
Go with `-role all`. This launcher does not reload sources automatically; restart
it after backend edits. `pnpm dev:server:node` retains the old nodemon entry point
when both driver flags are explicitly set to `node`.

For production, run `pnpm build` then `pnpm serve`. Set `JWT_SECRET`, database and
Redis settings, and a random `REALTIME_INTERNAL_TOKEN` of at least 32 characters.
The dev launcher can generate an ephemeral service credential shared by its
children; production fails startup without one. No credential is printed or saved.
Set `REALTIME_BINARY` to an absolute prebuilt binary path to skip building at startup.

| Setting | Default / purpose |
| --- | --- |
| `REALTIME_DRIVER` / `OUTBOX_DRIVER` | Root launcher: `go` / `go`; direct Node entry: `node` / `node` when unset |
| `PORT` / `NODE_PORT` | Public `3000` / business `3001` |
| `NODE_INTERNAL_URL` | `http://127.0.0.1:3001`; change with `NODE_PORT` |
| `GO_REALTIME_ADDR` | `:3000`; worker-only launcher uses `127.0.0.1:3101` |
| `BIND_HOST` | Node binds loopback with Go gateway; use a private address across hosts |
| `OUTBOX_CONCURRENCY` | 8 independent room heads, bounded to 128 |
| `OUTBOX_LEASE_SECONDS` / `OUTBOX_POLL_MS` | 60 seconds / 2000 ms; notifications wake scans sooner |
| `GO_SOCKET_QUEUE` / `GO_ROOM_QUEUE` | 128 frames per connection / 256 events per active room |
| `GO_MAX_CONNECTIONS` | 20000, includes in-progress handshakes |
| `METRICS_TOKEN` | Required bearer credential for metrics; unset disables scraping |

Node and Go must share the same MySQL target, Redis database and `REDIS_KEY_PREFIX`.
The launcher resolves Node's legacy database fallback into shared `DB_*` variables.
Standalone Go reads environment variables, not `model/config.json`; configure explicit
database settings before migration. The Go worker uses a pool capped at 12 connections
per process. Node's pool is independent: account for every process when sizing MySQL.

For separate deployment, start the same binary with `-role gateway` or `-role worker`.
Give each process its own listen address. A worker needs MySQL and Redis; a gateway
needs Redis, JWT verification material and the private Node URL. Apply migrations
before starting either role, and keep the Node business port off the public network.
Set driver flags to match the running consumers. The Go binary does not read `.env`
itself: supply environment variables through the launcher or deployment environment.

## Contracts and failure behavior

- Public WebSocket paths, HTTP APIs, SSE, attachment URLs and message frame fields
  remain unchanged. HTTP/SSE/downloads are streamed through Go without response buffering.
- The private `/internal/realtime/{ready,authorize,history,send,presence-online,presence-offline}`
  bridge requires the service credential. User operations additionally require the
  original JWT and Redis session. Actor IDs come from that JWT; callers cannot choose
  a sender. Offline cleanup is service-only and cannot mark an active lease offline.
- The public Go entry point blocks the Node internal bridge, including encoded and
  case-varied paths. It discards client-supplied forwarded-IP chains before proxying.
  Behind another reverse proxy, the upstream peer is the rate-limit identity; do not
  enable arbitrary forwarded-header trust.
- Existing Redis message/notification/session channels remain compatible. Go events
  add optional `version: 1`; legacy events without a version remain accepted.
  Shared wire samples live in `contracts/realtime-v1.json` and are checked in both languages.
- Original tokens are checked before writes and actual socket sends. Revocation events
  close idle connections promptly; periodic checks cover missed events. Membership is
  revalidated inside the message write transaction and before room content, history or
  read receipts are written. Send ACK/error replies still check the JWT and Redis session,
  but do not repeat a room authorization RPC for an operation result.
  Room-access revocation events also close idle connections. Presence refresh targets
  only the changed user's contacts; control/data/wake subscriptions are isolated.
- Notification presence is a 30-second Redis lease renewed every 15 seconds. Replacement
  events and compare-and-delete cleanup prevent an old connection removing a new lease.
  Friend and RTC reads use Redis, including after an ungraceful process crash.
- A socket's send queue holds at most 1 MiB and its configured frame count; the single
  initial-history response has a separate 2 MiB bound. Room queues are bounded;
  overflow closes affected connections, allowing history recovery. Socket writes time
  out after 5 seconds. Receipts are per-connection, single use, expire after 30 seconds,
  and are capped at 128 per connection / 20000 per gateway.
- Go claims only the oldest undelivered row per conversation. A leased or backing-off
  head blocks its own followers, not other rooms. Renewals and completions check the
  claim token; an expired owner cannot revive or complete its claim. A failed renewal
  cancels delivery. Already-published events cannot be retracted.
- Delivery is at least once. Publishing and database completion cannot be atomic;
  crashes may repeat events. Completion means publication, not client receipt or read.
  Redis Pub/Sub does not replay offline events. Clients merge message IDs and recover
  from persisted history; subscription reconnect sends `resync`.
- Gateway-to-Node calls have a 10-second timeout and are never automatically retried
  inside Go. An uncertain send returns a retryable error with the original client ID.
  The client retries the same ID, preserving the existing transaction idempotency.

## Health, checks and rollback

Each Go process exposes `/internal/live`, `/internal/ready` and `/internal/metrics`.
Readiness requires its Redis subscription and dependencies; a gateway also checks
Node's credential-protected database/Redis readiness. Scrape Go and private Node metrics separately: Go owns connection,
receipt and worker metrics, Node owns business admission and transaction metrics.
Metric labels contain no user IDs, room names or message bodies.

```powershell
pnpm test:realtime
pnpm test:realtime:soak
pnpm test:ops
cd services/realtime
go test ./...
go vet ./...
# Linux CI (or a local C toolchain):
go test -race ./...
```

`test:realtime` creates an isolated database/prefix/upload root, checks leases and
fencing against real MySQL, and tests all four Node/Go driver combinations with two
gateway instances. It verifies real files, confirmation sends, RTC signaling,
subscription reconnect and revocation. It also writes a local fixed-rate smoke
comparison to `test-results/go-realtime-*/report.json`; the workload, process counts,
latency budget and RSS snapshot limitations are recorded in the report. These small
local runs are not production capacity estimates or a language speedup claim.

For real-browser Go checks, set `TEST_GO_REALTIME=1` and run the isolated browser
runner with `real-chat.e2e.spec.ts`, `assistant-message-send.e2e.spec.ts`,
`file-drop.e2e.spec.ts` or `real-rtc.e2e.spec.ts` (the latter needs LiveKit).

Rollback: stop Go workers first and wait for in-flight work to finish or the configured
lease to expire. Stop/re-route the gateway, set both drivers to `node`, and restart the
root launcher. When changing ports, update any explicitly set `NODE_INTERNAL_URL`
and `GO_REALTIME_ADDR`, or unset them to use the launcher's defaults. Clients reconnect and retain message IDs;
duplicate publications remain possible. No schema rollback is required. Remove the
Node implementations only in a separate change after the acceptance window.
