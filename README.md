# nexus-core

Control-plane core for an agentic **Code → Compile → Test → Patch** loop.
The LLM proposes; a pure reducer decides. The model never picks the next state.

![CI](../../actions/workflows/ci.yml/badge.svg)

## Design

| Concern | Mechanism | File |
|---|---|---|
| Deterministic transitions | Pure `δ(state, artifact, usage, cfg)`; time enters only via `usage.nowMs` | `src/reducer.ts` |
| Loop / explosion control | Transition, token, USD and wall-clock budgets; per-failure-fingerprint cap; `(state, treeRoot, fp)` cycle detection; lexicographic progress score with rollback | `src/reducer.ts` |
| Failure identity | Diagnostic normalization (paths, lines, hex, timestamps, PIDs) then SHA-256 over the failure set | `src/fingerprint.ts` |
| Context budgeting | Tiered prompt (pinned / working / failure / ledger), head+tail truncation with retrievable elision markers, template-built attempt ledger, `promptSha` for replay | `src/context.ts` |
| Persistence | Postgres append-only event log (hash-partitioned, RLS per tenant) is the source of truth; Redis is lease + fence source + hot cache | `src/store.ts` |
| Writer safety | Single writer per `(run, branch)`; **fencing enforced in Postgres** (PK on `seq` plus `fence` guard), so a zombie worker with an expired Redis lease cannot write | `src/store.ts`, `src/driver.ts` |

### Sandbox (see [docs/sandbox.md](docs/sandbox.md))

LLM-generated code runs in one gVisor container per run: no network, read-only rootfs, all capabilities dropped,
0.5 vCPU / 512 MiB / 128 PIDs, output captured in bounded memory, hard timeouts, TTL self-destruct. The runtime
fails closed if `runsc` is missing.

### Jobs (see [docs/jobs.md](docs/jobs.md))

BullMQ provides at-least-once delivery; a Postgres write-ahead ledger plus provider-side tokens provide exactly-once
effect. Keys are `sha256(tenant, run, step, action, canonical params)` and never include the retry attempt.
Ambiguous failures (timeouts, 5xx) are resolved by token or lookup, never blind retry. A reconciler adopts crashed-but-created
resources and reaps orphans, with a blast-radius cap.

### Key trade-offs

- **Template ledger over LLM summaries.** Lossier on nuance, but replayable and it never silently drops negative knowledge ("tried X, failed because Y").
- **Synchronous commit per transition.** About 1–3 ms against LLM latency in the hundreds of ms to seconds, so consistency wins.
- **No multi-node Redlock.** Postgres is already the arbiter; Redis only reduces contention.
- **Aggressive guards raise false escalations** on legitimately hard bugs. Tune `maxPatchPerFp` and `stallWindow` from replayed audit data.

## Status

| Area | State |
|---|---|
| Reducer, fingerprinting, context utilities | Implemented, unit-tested (`npm test`) |
| Postgres event store, Redis lease manager | Implemented, **not yet integration-tested** against real Postgres/Redis |
| Sandbox: Docker Engine client, gVisor/hardened container policy, exec stream demux, tar upload, concurrency limits | Implemented, unit-tested against an in-process fake Docker daemon, **not yet run against real Docker/gVisor** |
| MCP server (`src/mcp/server.ts`) | Implemented, not yet exercised end to end |
| Idempotency keys, write-ahead ledger, runner, backoff, circuit breaker, DLQ triage, orphan reconciler | Implemented, unit-tested (including crash-recovery scenarios) |
| BullMQ topology/workers (`src/jobs/queues.ts`), Postgres ledger (`src/jobs/pgLedger.ts`) | Implemented, **not yet run against real Redis/Postgres** |
| tree-sitter AST slicing for the working-set tier | Not implemented |
| Parallel candidate branches and join reducer | Not implemented (`branchId` is plumbed through) |
| Real tokenizer | Not implemented (`chars / 4` estimate) |

Planned next: Testcontainers zombie-writer test for fencing; real-Docker/gVisor integration test for the sandbox; Testcontainers tests for the BullMQ adapter and Postgres ledger; Section 4 (compliance proxy and vector cache).

## Develop

```bash
npm install
npm run typecheck
npm test        # Node >= 22.6 (uses --experimental-strip-types)
```

## License

MIT
