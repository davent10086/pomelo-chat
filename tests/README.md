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
npm run test:unit
npm run test:database
npm run test:api
npm run test:integration
npm run test:security
npm run test:coverage
npm run test:all
```

Real LLM, browser media, TURN/NAT, WebSocket load, and performance tests are intentionally not part of
`test:all`: they require their respective isolated services and cost/device/network controls.
