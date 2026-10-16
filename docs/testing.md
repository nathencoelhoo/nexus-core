# Testing strategy

Four tiers, each answering a different question. A tier that needs a real service runs as its own CI job so a
failure there never hides the results of the others.

| Tier | Runs | Needs | Answers |
|---|---|---|---|
| Unit (`npm test`, 76 tests) | CI job `test` | nothing | Is the logic right? State machine, idempotency, scrubber, cache policy, against in-memory stand-ins |
| Integration (`npm run test:integration`, 35 tests) | CI job `integration` | Postgres + pgvector, Redis | Do the real databases behave the way the stand-ins assumed? |
| Docker (`npm run test:docker`, 14 tests) | CI job `docker` | Docker daemon | Does the sandbox actually isolate, and does the Docker client work against the real API? |
| gVisor (same Docker suite, `NEXUS_RUNTIME=runsc`) | CI job `gvisor` (allowed to fail) | Docker + runsc | Same, under the user-space kernel |

Integration and Docker tests are skipped unless `NEXUS_ITEST=1` / `NEXUS_DOCKER_ITEST=1`, because several tests drop tables
and flush Redis. For local runs use `docker-compose.integration.yml`.

## What each integration test is for

- **`eventstore`**: duplicate seq, stale-fence rejection, 8-way races on one seq (exactly one winner, no gaps), per-branch independence, row-level security on a non-superuser role (superusers bypass RLS, so the tests use a separate role), append-only grants, hash partitions, no connection leaks on failed appends.
- **`lease`** and **`fencing`**: the Lua scripts on a real Redis; the headline scenario (a writer stalls past its lease, a new owner writes, the zombie wakes up and is rejected by Postgres); and the Redis-counter-loss case.
- **`ledger`**: atomic `begin` under 25 concurrent callers, lease expiry on the database clock, and a **model-based differential test**: 1,250 random operations are applied to both `PgLedgerStore` and `MemoryLedgerStore`, and every result and every row must match. This is what justifies trusting the unit tests that use the in-memory ledger.
- **`cache`**: pgvector search against the in-memory reference (same entries, order and similarity), exact-match gates in SQL, RLS, quarantine and revival, and filtered ANN recall in a table dominated by another tenant.
- **`queue`**: BullMQ + Postgres ledger + a fake provider end to end: exactly-once under duplicate enqueues, ambiguous failure recovery, permanent failures quarantined, exhausted jobs landing in the DLQ with the right decision, redrive, admission control.
- **`docker`**: the hijacked exec stream, tar upload into a running container, unprivileged user, read-only rootfs, `noexec` tmp, no network, dropped capabilities and cgroup limits (runc), OOM kill, timeout, flood kill, bounded capture, end-to-end scrubbing, TTL self-destruct, orphan reaper, concurrency limits.

For the full story, including how each was found and what pins the fix, see [what-the-tests-found.md](what-the-tests-found.md).

## Defects found while writing these tests

Designing the tests, before any of them ran, exposed:
1. `store.ts` used TypeScript parameter properties, which Node's type stripping rejects: the fencing code had never executed at all.
2. A Redis counter reset would have locked a new owner out of a run forever (safety held, liveness did not). Fences are now floored from Postgres on acquire.
3. Permanent failures were reaching the DLQ classified as transient, because the BullMQ wrapper erased the error class.
4. The BullMQ worker had no `error` listener, so a Redis connection error would have crashed the process.
5. `run_events` is hash-partitioned but the DDL created no partitions, so no insert could succeed.

Found by actually running them:
6. The Docker archive API cannot upload into this sandbox at all (`container rootfs is marked read-only`); it also cannot write into a tmpfs.
   Uploads now stream into `tar -x` inside the container. My earlier docs described the archive approach as working; they were wrong.

7. The RLS policies cast `current_setting('app.tenant_id')` straight to uuid, so a connection with no tenant bound failed with
   `invalid input syntax for type uuid: ""` instead of an RLS decision (found by the append-only test). Policies now use
   `nullif(current_setting('app.tenant_id', true), '')::uuid`: an unbound tenant sees no rows and cannot write, and a test pins that.

## Known limits of the tests themselves

- gVisor and cgroup-v1 hosts report different views of limits; those assertions are runc-only and tolerate missing files.
- Timing-based tests (lease expiry, timeouts) use generous margins but can still flake on a very slow runner.
- Nothing here measures performance, ANN recall at scale, or behavior under network partitions.
