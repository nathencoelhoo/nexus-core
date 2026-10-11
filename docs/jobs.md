# Task queue, idempotency and backpressure (Section 3)

## Delivery model
BullMQ gives **at-least-once** delivery: a job can run twice (worker crash, stalled-job recovery, redrive).
The system provides **exactly-once effect** for external side effects by layering a write-ahead ledger and
provider-side idempotency tokens on top. The queue is never trusted for safety; Postgres is.

## Topology
| Queue | Purpose | Notes |
|---|---|---|
| `nexus-agent` | LLM / agent step jobs | Concurrency tuned to model rate limits |
| `nexus-infra` | External actions (AWS, Vercel, GitHub) | Worker `limiter` enforces provider API quota |
| `nexus-dlq` | Parking lot for exhausted jobs | No worker; triaged by `triage()` and redriven explicitly |

Redis names cannot contain `:`, hence hyphens. Producers call `enqueue()`, which uses the idempotency key as the
BullMQ `jobId` (a producer retry cannot enqueue a duplicate) and rejects with `BackpressureError` when
`waiting + delayed` exceeds a depth limit, so latency cannot grow without bound.

## Idempotency key
`key = sha256(len-prefixed [tenantId, runId, stepId, action, canonicalJson(params)])`, 64 hex chars.
- `stepId` is the deterministic position in the run (Section 1 `branch:seq`), **never the retry attempt**, so every retry of a step produces the same key.
- Canonical JSON rejects `undefined`, `NaN`, `Date`, `Map` and class instances, because a silently different encoding produces a different key and therefore a duplicate side effect.
- The same key is the ledger primary key and the provider token. 64 chars matches AWS EC2 `ClientToken` exactly. A provider with a shorter limit would need a token column in the ledger.

## Write-ahead ledger (`action_ledger`)
`begin()` is a single atomic statement and the only gate in front of a side effect:

| Existing row | Result |
|---|---|
| none | insert `INTENT` + lease, **started** |
| `UNKNOWN`, or `INTENT` with expired lease | take over, attempt+1, **resumed** |
| `INTENT` with live lease | **in_flight** (never double-execute) |
| `SUCCEEDED` | return stored result (**deduped**) |
| `FAILED` / `COMPENSATED` | permanent failure |

Every later write (`extendLease`, `succeed`, `fail`, `markUnknown`) is fenced by `attempt`: a worker whose lease
expired cannot overwrite the record of the worker that took over. Lease time uses the database clock, so worker
clock skew cannot shorten a lease. A heartbeat extends the lease; if extension is refused the in-flight call is
aborted via `AbortSignal` (`LeaseLost`).

## Crash matrix
| Crash point | State left | Recovery |
|---|---|---|
| Before `begin()` | nothing | plain retry |
| After `begin()`, before provider call | `INTENT` | lease expires, **resumed**, lookup finds nothing, execute |
| During provider call (outcome unknown) | `INTENT` / `UNKNOWN` | **resumed**: `lookup(token)` adopts the resource, or the provider dedupes on the token |
| After provider success, ledger write fails | `UNKNOWN` (or `INTENT` if the DB is fully down) | same as above; never marked `FAILED` |
| Ledger OK, queue ack lost | `SUCCEEDED` | redelivery returns the stored result without calling the provider |

Providers without native idempotency **must** implement `lookup()`; `assertAction()` enforces this at registration.

## Error classes
`ambiguous` is the important one: timeouts, connection resets and 5xx mean the request **may have executed**.
These are resolved by token or lookup, never by blind retry. `not sent` errors (`ECONNREFUSED`, DNS) are plain
`transient`. 4xx (except 408/409/429) are `permanent`, 401/403 are `auth`, programming errors (`TypeError`,
`RangeError`) are `permanent` so they quarantine instead of burning attempts.
`auth` is job-permanent but ledger-retryable, so a redrive after fixing credentials works.

## Backoff
Full jitter: uniform in `[0, min(cap, base * 2^(attempt-1)))`, which minimizes synchronized retry herds.
`Retry-After` is honored as a floor but capped (a hostile header cannot park a job forever).

## Circuit breaker
Per provider: opens after N consecutive transient/ambiguous/throttled failures, lets exactly one probe through
after `openMs`. While open the worker throws a retryable error carrying `retryInMs`, so backoff waits it out.
Trade-off: this burns an attempt per rejected job, which is acceptable because the DLQ redrives later.

## DLQ triage (`triage()`, pure)
| Condition | Decision |
|---|---|
| redrives >= max | escalate |
| run budget exhausted | escalate |
| permanent | **quarantine** (redrive cannot help) |
| auth | escalate and page a human |
| ambiguous | redrive, **reconcile first** |
| throttled / transient | redrive after `max(backoff, breaker.retryIn)` |

Redrive uses a new `jobId` (`<key>~r<n>`) because the failed original still exists; ledger dedupe makes that safe.

## Orphan reconciler
Because `begin()` writes `INTENT` before the provider call, every real resource has a ledger row. Two sweeps:
1. **Ledger to provider:** stuck rows whose resource exists are adopted as `SUCCEEDED`.
2. **Provider to ledger:** resources with no row, a `FAILED`/`COMPENSATED` row, or a dead run are deleted.
`maxReaps` caps the blast radius, so a buggy predicate cannot delete everything.

## Trade-offs
- **BullMQ over Temporal.** Redis is already in the stack and the safety guarantees live in Postgres, so swapping the queue later only touches `queues.ts`. Temporal gives durable workflows and history for free but needs a server cluster; BullMQ OSS has no native per-tenant fair scheduling (the semaphore in Section 2 and `limiter` are the mitigations).
- **Lease length vs recovery time.** After a hard crash the next attempt waits for lease expiry (default 30 s). Shorter leases recover faster but need a reliable heartbeat.
- **One ledger write per side effect.** Adds a database round trip per external call, which is negligible next to provider latency.

## Known gaps
- `PgLedgerStore` SQL and the BullMQ adapter (`queues.ts`) have **not run against real Postgres/Redis**. Unit tests use `MemoryLedgerStore`, which mirrors the SQL semantics; an integration test (Testcontainers) should confirm they agree.
- No real provider adapters yet (AWS, Vercel, GitHub); tests use a fake cloud with and without native idempotency.
- No Redis-level per-tenant fairness in the queue.
- The redriver loop (reading `nexus-dlq` and calling `redrive()`) is a function, not a running service.
