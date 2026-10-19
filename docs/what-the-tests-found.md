# What the tests found

A testing log, not a victory lap. Twelve defects were found while building this project's tests; most would have shipped
if the test suite had stopped at "the types compile and the unit tests pass". Each entry says what was wrong, how it was
found, why it mattered, and what pins the fix.

## The short version

- **On the first run against real services:** 32 of 33 integration tests passed (one failure), the first Docker test passed and the
  second failed, and gVisor failed to install. After fixes, all four CI jobs are green (unit 76, integration 35, Docker 14, the same 14 under gVisor).
- **Five of the seven infrastructure defects were found before any CI run**, by an import check and by the design work of writing
  the tests. Two were found by CI: one where a hand-written fake had agreed with the code only because the same person wrote both (#6), and one where Postgres behaved differently from an unexamined assumption (#7).
- **Fail-closed held every time.** Postgres rejected the stale writer, row-level security rejected the bad write, and the sandbox
  refused to start without gVisor. The defects were about *liveness*, *classification* and *wrong assumptions*, not about unsafe behavior.

## Found against real infrastructure (seven)

| # | Defect | Found by | Consequence if shipped |
|---|---|---|---|
| 1 | The fencing module used TypeScript parameter properties, which Node's type stripping rejects | A runtime import of every module | The code that enforces single-writer correctness had **never executed**; it only type-checked |
| 2 | Fence counter lived only in Redis | Designing the zombie-writer test | After a Redis flush or failover, a new owner got fence 1, below what Postgres had seen, and was **locked out of its run forever** |
| 3 | The BullMQ wrapper threw a generic `UnrecoverableError` | Designing the queue tests | Poison jobs reached the DLQ classified *transient* and would have been **redriven in a loop** |
| 4 | The BullMQ worker had no `error` listener | Design review | A Redis connection error is emitted as an `error` event; unhandled, it **crashes the process** |
| 5 | `run_events` is hash-partitioned but the DDL created no partitions | Writing the event-store test setup | **No insert could ever succeed** |
| 6 | Files were uploaded with Docker's archive API (`docker cp`) | The real Docker job | The daemon answered `400 container rootfs is marked read-only`; the API also cannot write into a tmpfs. **Uploads could not work at all** |
| 7 | RLS policy cast `current_setting('app.tenant_id')` straight to `uuid` | The real Postgres job (append-only test) | A connection with no tenant bound failed with `invalid input syntax for type uuid: ""` instead of an RLS decision (still safe, but a confusing failure mode) |

### 1. Compiling is not running
Type checking passed, CI was green, and the most safety-critical module in the project could not be imported at runtime.
No unit test touched it, so nothing noticed. The check that caught it was trivial: import every source file under the same
runtime the tests use. **Fix:** explicit class fields. **Pinned by:** the whole integration suite now imports and exercises `store.ts`.

### 2. Safety held, liveness did not
The fence is enforced in Postgres, so a wiped Redis could never allow a bad write. But the new owner's fence restarted at 1,
every write was rejected as stale, and the run was stuck. Safety properties and liveness properties need separate tests.
**Fix:** `LeaseManager.acquire(…, minFence)` floors the counter from `EventStore.maxFence`, inside the same Lua script as the
lock. **Pinned by:** `fencing.itest.ts` runs the failure first (the naive acquire is locked out) and then the fix.
The README's earlier claim that "wiping Redis loses nothing" was wrong and was corrected.

### 3. Classification is part of the contract
Retry policy depends on *why* a job failed, and the error class was lost when one exception type replaced another.
**Fix:** a subclass that carries the class through the queue library. **Pinned by:** an end-to-end test that a 400 from the
provider lands in the DLQ as `permanent` with a `quarantine` decision, with one provider call and a `FAILED` ledger row.

### 4 and 5. Defects that only a real system has
A missing event listener and a missing partition are invisible to any in-memory stand-in. They were found by writing the
integration tests' setup code and asking "what does the real thing require?".

### 6. A fake that agrees with you proves nothing
The in-process fake Docker daemon implemented the archive endpoint and the unit test passed, because the same author wrote
both and shared the same wrong belief. The real daemon disagreed in the second test. The earlier design doc had also stated the
approach worked; it was rewritten. **Fix:** stream a tar into `tar -x` running *inside* the container over exec stdin, which
lands in the real tmpfs owned by the sandbox user. **Pinned by:** a real-daemon test that nested directories are writable by
the sandbox user and modes are honored, plus a fake that now records the stdin it receives.

### 7. "Fails closed" can still fail badly
The statement was rejected, which is safe, but by a cast error rather than by the policy. An unbound tenant should be a
policy outcome: no rows visible, no writes allowed. **Fix:** `nullif(current_setting('app.tenant_id', true), '')::uuid`.
**Pinned by:** tests on both tables that an unbound connection sees nothing and cannot insert, and an append-only test that
binds a valid tenant first so the denial can only come from the grants.

## Found earlier, by unit tests (five)

| # | Defect | Found by |
|---|---|---|
| A | Scrubber output depended on chunking: when a boundary fell inside a private-key block, a newline was lost and the placeholder's tag changed | A test that splits one document at **every** byte offset |
| B | A URL password was labelled `email` | A detector table test; fixed with priority-based naming and a URL-aware email guard |
| C | Recording a success made a cache entry *less* eligible: an untested entry needed similarity of 0.97, but once it had one success it needed a Wilson lower bound of 0.4, which a single success (0.27) cannot reach | Writing the track-record test |
| D | The embedded text included tool, code and language, which are already exact-match gates; this lifted unrelated failures from 0.25 to 0.40 similarity | Measuring similarity for a test threshold |
| E | The idempotent runner's timers were `unref()`'d; a call waiting only on them was silently abandoned and the test runner cancelled six tests | The runner timeout tests |

Property-style tests (invariance over every split, every chunk size, random chunking; differential comparison of two
implementations) found A and the rest of the scrubber's edge cases that example-based tests would have missed.

## Measurements that were not bugs but changed what the docs say

- **A compressed similarity scale.** The lexical embedder ranks well (recall@1 0.875) but its same-fix pairs average only 0.77 similarity, so the default
  threshold of 0.92 serves about 10% of fixable repeats. Ranking quality and threshold calibration are separate; thresholds are now per embedder.
- **A real embedding model did not beat the lexical baseline.** On a 32-item fix-class benchmark the local MiniLM model tied on recall@1 (0.875) and
  served fewer correct repeats at equal precision (4 versus 9 of 48 pairs at precision >= 0.95), while being clearly better at natural-language paraphrase.
  The benchmark is small and the explanation is a hypothesis, so the conclusion recorded is "no evidence the model is better here", and the default stays lexical.
- **The AWS emulator does not enforce ClientToken idempotency** (the CI log says so). That tier proves the wire contract and the tag-lookup recovery path;
  the deduplication guarantee itself is checked only by the opt-in live test, which has not been run.

## What did *not* go wrong, and why that is informative

The Postgres ledger SQL matched the in-memory reference over 1,250 random operations on the first run, and the zombie-writer
scenario passed first time. Those tests exist precisely so that this result *means* something: a differential test that passes
is evidence the in-memory ledger can be trusted by the unit tests that use it.

## Mistakes made while diagnosing

- The first guess at which integration test had failed (the "permanent failure" test) was wrong. It was the event-store
  append-only test. The raw log said so; the guess did not.
- Two test thresholds were wrong in the tests themselves (a similarity floor of 0.4 sat right next to an unrelated pair's 0.402).
- Explicit casts were added to an `INSERT … SELECT` as a precaution. Whether Postgres would have inferred the types anyway
  is unknown, because the casts have been in place for every real run.

## What green does not mean

The suites run on one runner, with one runtime pairing per job. Capability, cgroup-limit and OOM assertions run on runc only,
and the cgroup and swap checks skip themselves if the files are absent. Nothing here measures performance, ANN recall at scale,
behavior under network partitions or against any real cloud provider, and the embedder is a lexical baseline rather than a
semantic model. A green run is evidence for the claims in the README's guarantees table, and for nothing beyond them.
