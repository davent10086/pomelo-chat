# Outbox pending-range scheduling

The delivery worker keeps its existing transaction, `SKIP LOCKED`, claim token,
lease renewal, retry backoff and at-least-once delivery behavior. This change
optimizes how eligible room heads are found; it does not acknowledge delivery
before persistence, bypass session checks, or introduce a second queue service.

## Query and data contract

Each outbox row now stores the authoritative `conversation_id` assigned during
message persistence. Both inserts remain in the same transaction.

- The outer query starts at `idx_outbox_pending(delivered_at, next_attempt_at)`.
  Delivered history is outside this index range.
- The predecessor lookup uses
  `idx_outbox_room_pending(conversation_id, delivered_at, message_id)`.
  It examines only pending predecessors in the same conversation, including
  leased heads and heads whose retry time has not arrived.
- Eligible heads are ordered by `next_attempt_at, message_id`, matching the
  pending index including its implicit primary-key suffix. No message-history
  join is needed.

This preserves room order without claiming every earlier message again. An
actively leased or backing-off room head blocks its own successors, while other
rooms can still be claimed. It is not a promise of strict round-robin fairness
or bounded end-to-end latency under arbitrary overload.

## Upgrade

The migration `outbox_pending_conversation_v1` runs under the existing migration
lock. It backfills the projection from message rows, makes it non-null, adds the
index, and records completion only after these steps succeed. Claims, lease
timestamps, retry counters, and delivery timestamps are unchanged. Repeated
initialization skips the completed migration.

For an existing deployment, stop old application workers and writers, back up
the database, run the migration, and restart the updated application. Old code
does not supply the new non-null column, so this is a coordinated upgrade rather
than a mixed-version rolling deployment. Large outbox tables can make the
backfill and index creation take time; evaluate them on a database copy first.
Rolling back the application also requires relaxing the new column constraint
or reverting the schema in a coordinated maintenance window.

## Verification

Run the isolated migrations and reliability suites:

```powershell
node server/scripts/run-isolated-tests.js migrations
node server/scripts/run-isolated-tests.js backend
node server/scripts/run-isolated-tests.js system
```

The migration test upgrades populated legacy outbox records and verifies leased,
pending and delivered rows survive unchanged. The reliability test includes
2,000 delivered historical rows, 1,000 pending followers behind a blocked head,
and an eligible new room; it checks both lease and retry isolation. Existing
competing worker, slow room, lease renewal and stale-token fencing tests remain.

Reproduce the burst that previously caused the delivery stall:

```powershell
$env:LOAD_PROFILE = 'followup'
$env:PRIME_MESSAGES = '16000'
$env:SOAK_SECONDS = '30'
node qa/benchmarks/comprehensive-load.mjs
```

This uses a separate database, Redis prefix and upload directory, with real
WebSocket traffic and 50 room pairs. It writes 16,000 messages, runs a 50-member
group burst, waits for recipient delivery, exercises files and bidirectional
traffic, and audits the database before cleanup. Reports include unsuccessful
phases, not just ACK throughput. Load generator and services share one machine;
results are not a production capacity estimate.

The sustained phase reports ACK-plus-recipient latency separately from its 50ms
think time. Older reports created before this measurement adjustment include
think time in that phase's latency; do not compare their raw percentiles without
accounting for that difference.
