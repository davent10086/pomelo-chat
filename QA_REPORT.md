# Pomelo Chat AI Assistant QA Report

Generated: 2026-07-21

## Scope

This QA pass tested the current instant messaging app as a real user and as an AI Agent tester:

- Auth and session behavior.
- Friend and group setup.
- Private chat WebSocket messaging.
- AI Assistant normal QA, context, long context, SSE, and prompt injection.
- Agent routing, trace, and MCP tool use.
- Internal MCP tools and memory isolation.
- File metadata security.
- API and WebSocket performance smoke.
- Automated regression assets.

## Evidence

- Project map: `PROJECT_TEST_MAP.md`
- MCP report: `MCP_TEST_REPORT.md`
- QA harness: `qa/qa-full-test.js`
- Latest QA result: `qa/results/qa-results-20260721065627.json`
- Unit test: `qa/unit-agent-logic.test.js`
- Postman collection: `qa/postman_collection.json`
- Playwright E2E spec: `qa/playwright/ai-assistant.e2e.spec.ts`

Latest full QA harness result:

- Pass: 27
- Warn: 1
- Fail: 0

Additional verification:

- `npm run build` in `server`: pass
- `npm run build` in `client`: pass, with Vite chunk-size warning
- `npm run test:agent-routing`: pass
- `npm run test:security`: pass
- `npm run test:mcp`: pass
- `npm run test:agent`: pass after script fix
- `node qa/unit-agent-logic.test.js`: pass

## System Score

| Area | Score | Rationale |
| --- | ---: | --- |
| Functionality | 8/10 | Core chat, friend/group, AI, Agent, memory, and MCP flows work. Multi-device login is blocked by current policy. |
| Stability | 7/10 | Main flows pass; key group input edge cases were fixed. External MCP quota/provider errors still leak into final answer content. |
| AI Capability | 7/10 | Normal QA, recent-message context, 100-turn context injection, tool use, and prompt-injection refusal pass. Agent streaming is lifecycle-event + final-result streaming, not token streaming. |
| Security | 8/10 | Auth, room isolation, SQL injection probe, file traversal probe, memory isolation, and prompt-injection probe passed. External MCP and direct memory-write endpoint need tighter controls/UX. |
| Performance | 7/10 | 100 concurrent `chat_list` p95 was about 150 ms; 60-message WebSocket burst delivered quickly. No long soak, CPU/memory profiling, or true 1000/min sustained run yet. |

## Fixed During This Pass

1. `server/src/service/group/index.ts`
   - Added validation for `createGroupChat` so missing/non-array `members` returns parameter error instead of crashing.
   - Avoided mutating `req.body.members` when adding the creator.
   - Added missing-record guards for group info and join-group lookup.
   - Fixed group invite multi-row insertion from invalid `INSERT ... SET ?` array usage to `INSERT ... VALUES ?`.

2. `server/scripts/test-agent.js`
   - Changed default test account from static `agent_test` to a unique per-run account to avoid stale Redis single-login state.

3. `qa/`
   - Added repeatable full QA harness.
   - Added unit test, Postman collection, and Playwright E2E spec.

## Top 20 Issues

### 1. Multi-device login is blocked

Severity: High

Reproduction:

1. Register/login a user.
2. Attempt to login again with the same credentials.
3. API returns business code `2002`.

Impact:

- The stated test persona includes multi-device users, but current Redis token whitelist enforces single-session login.

Fix suggestion:

- Decide product policy. For true multi-device support, store multiple session ids per user, bind WebSocket sessions to session ids, and support per-device logout.

### 2. External MCP provider errors can appear raw in AI output

Severity: Medium

Reproduction:

1. Ask for a travel plan that triggers Amap tools.
2. When Amap quota is exceeded, tool content includes provider error JSON.

Impact:

- Users see internal/provider-shaped errors instead of a clean degraded response.

Fix suggestion:

- Normalize MCP `isError` responses and include failed status in `toolTrace`; tell the model to summarize unavailable data instead of embedding raw JSON.

### 3. Agent stream is not token-level model streaming

Severity: Medium

Reproduction:

1. Call `POST /assistant/agent/stream`.
2. Observe lifecycle events and one final Agent result.

Impact:

- UI can show progress events, but not true incremental answer tokens.

Fix suggestion:

- Use model streaming in `runLangChainAgent` and emit partial answer deltas separately from Agent events.

### 4. AI rate limit prevents real same-user 100-turn live AI test

Severity: Medium

Reproduction:

1. Send more than 20 Agent requests for one user within a minute.
2. Rate limit blocks further requests.

Impact:

- Good for cost control, but long dialogue QA must use context injection or multi-user distribution.

Fix suggestion:

- Add test-mode rate-limit override or dedicated load-test key/tenant.

### 5. No sustained soak/performance telemetry

Severity: Medium

Reproduction:

1. Run current app under 30+ minutes of WebSocket and AI traffic.
2. No built-in memory/CPU/request metrics are emitted.

Impact:

- Memory growth and connection leaks are hard to prove or disprove.

Fix suggestion:

- Add process metrics, WebSocket connection gauges, DB query timing, AI latency histograms, and MCP latency/status counters.

### 6. Frontend bundle has a large chunk warning

Severity: Medium

Reproduction:

1. Run `npm run build` in `client`.
2. Vite warns that a chunk exceeds 500 kB.

Impact:

- Slower first load, especially on mobile/low-end networks.

Fix suggestion:

- Split route chunks and heavy Ant Design surfaces with dynamic import/manual chunks.

### 7. External MCP local schemas are too permissive

Severity: Medium

Reproduction:

1. Inspect `external-mcp.ts`.
2. External LangChain tools use `z.record(z.string(), z.unknown())`.

Impact:

- The model may send malformed args that only fail at provider time.

Fix suggestion:

- Convert remote JSON schemas into local validators where possible.

### 8. Group invite allows inviting arbitrary registered user ids

Severity: Medium

Reproduction:

1. As a group member, call `/group/invite_friend` with a user id that is not a friend.
2. The user is added.

Impact:

- Product may intend this, but most chat apps require friendship, invite consent, or admin policy.

Fix suggestion:

- Add explicit group invite policy: creator/admin only, friend-only, or consent-based.

### 9. Missing group lookup returns auth error for non-member/nonexistent group

Severity: Low

Reproduction:

1. Call `/group/group_info?group_id=99999999`.
2. Response is token/auth error because membership check fails first.

Impact:

- Security-safe, but confusing for clients and QA.

Fix suggestion:

- Keep non-member responses generic, but distinguish malformed/missing group in server logs and observability.

### 10. Business errors use HTTP 200

Severity: Low

Reproduction:

1. Call protected API without token.
2. HTTP status is 200 with body code `1002`.

Impact:

- Client must always parse body codes; standard API tooling and gateways cannot classify failures by HTTP status.

Fix suggestion:

- Keep body codes if needed, but return matching HTTP 4xx/5xx status for new APIs.

### 11. Direct tool-call endpoint exposes memory writes

Severity: Low

Reproduction:

1. Authenticated user calls `/assistant/agent/tools/call` with `save_memory`.
2. Memory is written.

Impact:

- Scoped to the current user, but there is no extra confirmation at API level.

Fix suggestion:

- Require `confirmed: true` for write-kind tools or restrict write tools to Agent-mediated explicit-memory flows.

### 12. Prompt injection protection depends mostly on model behavior

Severity: Low

Reproduction:

1. Ask Agent to reveal system prompt/API key.
2. Current model refused during test.

Impact:

- Passing behavior may vary by model/version.

Fix suggestion:

- Add deterministic output guardrails that redact secret-shaped strings and block system-prompt disclosure patterns.

### 13. AI stream sanitize differs between endpoints

Severity: Low

Reproduction:

1. Compare non-stream `/assistant/chat` sanitization and stream proxy behavior.
2. Non-stream sanitizes final text; stream forwards provider chunks.

Impact:

- Frontend sanitizes deltas, but API consumers of stream endpoint must do their own filtering.

Fix suggestion:

- Document the contract or sanitize assembled stream deltas before emitting.

### 14. Chat WebSocket has no per-room message rate limit

Severity: Low

Reproduction:

1. Send a burst of messages over an authorized WebSocket.
2. Server accepts rapid messages as long as each is under 10000 chars.

Impact:

- Abuse can pressure DB and notification fanout.

Fix suggestion:

- Add per-user/room WebSocket message rate limit and backpressure handling.

### 15. WebSocket send failures are logged but not surfaced to sender

Severity: Low

Reproduction:

1. Force a room member socket send failure.
2. Server logs error while sender receives no structured delivery failure.

Impact:

- User may think delivery succeeded.

Fix suggestion:

- Add ack/error events with message ids.

### 16. Messages do not have client-generated idempotency keys

Severity: Low

Reproduction:

1. Client retries after network uncertainty.
2. Server has no duplicate-suppression key.

Impact:

- Duplicate messages are possible under reconnect/retry.

Fix suggestion:

- Add `client_message_id` unique per sender/room.

### 17. Search endpoints use broad LIKE queries

Severity: Low

Reproduction:

1. Search contacts/groups with a short wildcard-like term.
2. DB uses `%query%`.

Impact:

- Fine for small data, may slow with larger users/groups.

Fix suggestion:

- Add indexes and minimum query length/rate limits; consider full-text search later.

### 18. Playwright is generated but not wired into package scripts

Severity: Low

Reproduction:

1. Inspect package scripts.
2. No E2E command exists.

Impact:

- E2E will not run in CI unless manually invoked.

Fix suggestion:

- Add Playwright dependency/config and CI script when ready.

### 19. Test data cleanup is partial

Severity: Low

Reproduction:

1. Run QA harness multiple times.
2. Unique QA users/groups/messages remain in MySQL.

Impact:

- Local DB accumulates test data.

Fix suggestion:

- Add a test tenant flag or cleanup script for `qa_*` fixtures.

### 20. No explicit AI evaluation dataset

Severity: Low

Reproduction:

1. Inspect repo.
2. AI behavior is covered by smoke tests but not scored against a stable eval set.

Impact:

- Regressions in answer quality/tool choice may be missed.

Fix suggestion:

- Create an eval dataset for context recall, tool choice, prompt injection, memory write/forget, and route planning.

## Automation Delivered

Unit tests:

- `qa/unit-agent-logic.test.js`
- Existing: `server/scripts/test-agent-routing.js`
- Existing: `server/scripts/test-security-regressions.js`

API tests:

- `qa/postman_collection.json`
- `qa/qa-full-test.js`

E2E tests:

- `qa/playwright/ai-assistant.e2e.spec.ts`

## Next Optimization Roadmap

Phase 1: Product and security hardening

- Decide multi-device session model.
- Normalize external MCP failures.
- Add deterministic AI redaction/output guardrails.
- Add confirmation semantics for write-kind tools.

Phase 2: Reliability and observability

- Add message ids and delivery acks.
- Add WebSocket rate limit/backpressure.
- Add structured metrics for WebSocket, DB, AI, MCP, and memory.
- Add cleanup tooling for QA data.

Phase 3: AI quality

- Add stable AI eval dataset.
- Add true token-level Agent streaming.
- Add stricter external MCP schema validation.
- Improve long-context compression strategy.

Phase 4: Performance and UX

- Wire Playwright into CI.
- Split frontend bundles.
- Run sustained 100-user/1000-message-per-minute soak with metrics.
- Add user-facing degraded states for AI/MCP quota and provider failures.
