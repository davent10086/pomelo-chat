# Pomelo Chat test suite

Every test run receives a unique `test_run_id` and may write temporary files only below
`tmp/tests/<test_run_id>`. The lifecycle helper removes that directory even when a test fails.

Database integration requires all of the following:

- `NODE_ENV=test` (or `APP_ENV=test`)
- `DATABASE_URL_TEST` (or `TEST_DATABASE_URL`)
- a database name containing `test`, for example `pomelo_chat_test`

The application rejects a test-mode connection without those safeguards. Test Redis keys must use
`test:<test_run_id>:` and teardown may only scan/delete that prefix. LiveKit tests need a dedicated
LiveKit server plus isolated test users and rooms; production credentials and rooms must never be used.

Commands:

```powershell
# Create a dedicated MySQL test database first, then replace these example credentials.
$env:DATABASE_URL_TEST='mysql://root:password@127.0.0.1:3306/pomelo_chat_test'
$env:REDIS_URL_TEST='redis://127.0.0.1:6379/15'

pnpm test:unit
pnpm test:database
pnpm test:api
pnpm test:integration
pnpm test:security
pnpm test:coverage
pnpm test:all
pnpm test:qa
pnpm test:desktop
pnpm test:desktop:smoke
# Windows: build first, then run the packaged app against freshly isolated services
pnpm build:desktop
pnpm test:desktop:production
```

`test:all` uses the configured test database; it does not create it. For local service-backed
checks that create and remove their own database, use `node server/scripts/run-isolated-tests.js`
with `system`, `backend`, `migrations`, or `browser`. The runner reads local MySQL credentials
from `server/.env`. `pnpm test:real-chat` uses that runner to verify two real browser clients,
including private read receipts, sender refresh and offline-message read recovery.

Message overload checks run with `node server/scripts/run-isolated-tests.js overload`.
They exercise real Redis/MySQL admission, bounded queues, receipts and HTTP 429.
`test:all` also includes `test:message-overload` against its configured test targets.
The browser case is `message-overload.e2e.spec.ts`; browser artifacts use
`test-results/browser/` so browser runs preserve benchmark reports alongside them.

Real LLM, browser media, TURN/NAT, WebSocket load, and performance tests are intentionally not part of
`test:all`: they require their respective isolated services and cost/device/network controls.

`pnpm test:qa` starts an isolated test server and requires `DATABASE_URL_TEST` and `REDIS_URL_TEST`.
It creates only `qa_<runId>_*` records and deletes its database, Redis, and temporary artifacts on exit.
