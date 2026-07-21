# MCP Test Report

Generated: 2026-07-21

Evidence:

- QA harness: `qa/qa-full-test.js`
- Latest result: `qa/results/qa-results-20260721065627.json`
- Existing MCP script: `server/scripts/test-mcp-stdio.js`

## Summary

- Internal Pomelo MCP tools tested: 8/8.
- External MCP tools discovered in live environment: 16.
- Tool listing endpoint passed.
- Internal tool happy paths passed.
- Internal tool parameter validation passed for required-argument tools.
- User memory isolation passed.
- Room authorization for `get_recent_messages` passed.
- Existing stdio MCP script passed.

## Tool Inventory

Internal tools:

- `get_recent_messages`
- `search_contacts`
- `search_groups`
- `extract_todos`
- `suggest_replies`
- `search_memory`
- `save_memory`
- `forget_memory`

External MCP tools observed:

- `mcp_aliyun-web-search_bailian_web_search`
- `mcp_amap-maps_maps_direction_bicycling`
- `mcp_amap-maps_maps_direction_driving`
- `mcp_amap-maps_maps_direction_transit_integrated`
- `mcp_amap-maps_maps_direction_walking`
- `mcp_amap-maps_maps_distance`
- `mcp_amap-maps_maps_geo`
- `mcp_amap-maps_maps_regeocode`
- `mcp_amap-maps_maps_ip_location`
- `mcp_amap-maps_maps_schema_personal_map`
- `mcp_amap-maps_maps_around_search`
- `mcp_amap-maps_maps_search_detail`
- `mcp_amap-maps_maps_text_search`
- `mcp_amap-maps_maps_schema_navi`
- `mcp_amap-maps_maps_schema_take_taxi`
- `mcp_amap-maps_maps_weather`

## Internal Tool Matrix

| Tool | Invalid Args Result | Valid Call Result | Notes |
| --- | --- | --- | --- |
| `get_recent_messages` | `200` | `200` | Empty args are allowed because room can default to current room. |
| `search_contacts` | `1003` | `200` | Required `query` enforced. |
| `search_groups` | `1003` | `200` | Required `query` enforced. |
| `extract_todos` | `1003` | `200` | Required `text` enforced. |
| `suggest_replies` | `1003` | `200` | Required `text` enforced. |
| `search_memory` | `200` | `200` | Empty query is allowed by design. |
| `save_memory` | `1003` | `200` | Required bounded `content` enforced. |
| `forget_memory` | `1003` | `200` | Required `query` enforced. |

## Permission Tests

Memory isolation:

- User A saved `qa-private-memory-*`.
- User A search returned the memory.
- User B search returned an empty list.
- Result: pass.

Room isolation:

- User A had access to private room A-C.
- User B called `get_recent_messages` for room A-C.
- Tool returned empty messages.
- Result: pass.

WebSocket room isolation:

- User B attempted to connect to room A-C.
- Server sent an error and closed with `4003`.
- Result: pass.

## Failure and Recovery Tests

- Invalid required arguments return business code `1003`.
- Unknown or failed tool calls are caught by `/assistant/agent/tools/call` and returned as parameter errors.
- External MCP quota failure was observed during travel-plan testing: Amap returned `USER_DAILY_QUERY_OVER_LIMIT` inside tool content. The Agent still produced a final answer, but the final content included raw tool failure JSON.

## Findings

1. External MCP failures are not normalized for user display.
   - Severity: Medium.
   - Impact: User may see provider errors such as `USER_DAILY_QUERY_OVER_LIMIT` embedded in an AI answer.
   - Recommendation: Normalize MCP `isError` payloads into concise user-facing messages and include failed tool status in `toolTrace`.

2. External MCP schema validation is broad.
   - Severity: Medium.
   - Impact: External tools use `z.record(z.string(), z.unknown())`; model/tool-call argument mistakes are mostly deferred to remote tools.
   - Recommendation: Convert remote JSON schemas to stricter local Zod schemas where possible.

3. MCP stdio context is static.
   - Severity: Low.
   - Impact: `POMELO_MCP_USER_ID` and optional room are process-level values. This is fine for local stdio, but not enough for multi-user hosted MCP.
   - Recommendation: Keep stdio local-only or introduce per-request auth context for hosted MCP.

4. Write-tool confirmation exists only for configured external tools.
   - Severity: Low.
   - Impact: Internal `save_memory` and `forget_memory` can be called directly by authenticated users through the tool-call endpoint.
   - Recommendation: This is acceptable for explicit user calls, but UI should label memory writes clearly.

## Verdict

MCP core is functional and has good user/room isolation for internal tools. The main next step is improving external MCP failure normalization and schema strictness.
