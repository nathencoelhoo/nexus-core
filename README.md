# nexus-core

[![CI](https://github.com/nathencoelhoo/nexus-core/actions/workflows/ci.yml/badge.svg)](https://github.com/nathencoelhoo/nexus-core/actions/workflows/ci.yml)

Control plane for an autonomous **Code → Compile → Test → Patch** agent loop, built around one rule: **the model proposes, deterministic code decides.**
The LLM never picks the next state and never touches the host; secrets and PII the scrubber recognizes are redacted before the model sees them; and a retry cannot repeat an external side effect.

It is a TypeScript reference implementation of the four hard parts of running LLM-written code in production:
a deterministic state machine, an isolated sandbox, exactly-once external actions, and a compliance boundary in front of the model.
102 unit tests and 59 integration tests (real Postgres with pgvector, Redis, Docker, gVisor, an AWS emulator and a local embedding model) run in CI as separate jobs. Four more opt-in tests target a live AWS account and have not been run. See [Status](#status-what-is-and-is-not-verified) for what is and is not verified.

## Architecture

```mermaid
flowchart TB
  subgraph CP["Control plane (trusted)"]
    RED["Pure reducer<br/>delta(state, artifact, budget)"]
    CTX["Context builder<br/>scrub, then truncate"]
    SCR["Streaming scrubber<br/>secrets and PII"]
    CACHE["Fix cache<br/>fingerprint + pgvector"]
    MCP["MCP server<br/>one per tenant and run"]
    MGR["Sandbox manager<br/>limits, TTL, reaper"]
    WRK["BullMQ workers<br/>agent, infra, DLQ"]
  end
  subgraph ST["State"]
    PG[("Postgres<br/>event log, action ledger, fix cache")]
    RD[("Redis<br/>leases, fences, queues")]
  end
  subgraph SB["Untrusted"]
    GV["gVisor container<br/>no network, read-only rootfs"]
  end
  LLM["LLM and embedding APIs"]
  EXT["AWS, Vercel, GitHub"]
  MCP --> MGR --> GV
  GV -- "multiplexed stdout and stderr" --> SCR
  SCR --> CTX --> LLM
  LLM --> RED
  RED -- "fenced append" --> PG
  RED -- "lease and fence" --> RD
  RED --> CACHE --> PG
  WRK -- "write-ahead intent" --> PG
  WRK -- "idempotency token" --> EXT
```

**Design principles**
- **Postgres is the arbiter.** Redis holds leases, the fence counter and a hot cache. Safety comes from primary keys, fencing and fenced updates in Postgres; if Redis loses its counter, fences are re-seeded from Postgres on the next lease acquire.
- **Fail closed.** Missing `runsc` refuses to start. An unterminated private key is redacted. A desynced exec stream kills the sandbox. A full queue rejects instead of buffering.
- **Every guard is enforced in code, not in a prompt.** Budgets, loop limits and isolation parameters live in reviewable, tested modules.
- **Trade-offs are written down.** Each design doc lists what a choice costs and what is deliberately not covered.

## The four modules

### 1. Deterministic state machine and context engine
`src/reducer.ts` `src/fingerprint.ts` `src/context.ts` `src/store.ts` `src/driver.ts`

```mermaid
flowchart LR
  CODE -->|patch applied| COMPILE
  COMPILE -->|exit 0| TEST
  COMPILE -->|diagnostics| PATCH
  TEST -->|failures| PATCH
  PATCH -->|diff applied| COMPILE
  TEST -->|all green| SUCCESS(["SUCCESS"])
  CODE & COMPILE & TEST & PATCH -.-> G{"Reducer guards"}
  G -->|"repeat, oscillation, stall"| ESCALATE(["ESCALATE"])
  G -->|"transitions, tokens, USD, time"| BUDGET(["BUDGET_EXHAUSTED"])
  G -->|"unsafe artifact"| UNSAFE(["FAILED_UNSAFE"])
```

- The reducer is a pure function with no clock and no I/O, so any run replays deterministically from the event log.
- **Loop control, in layers:** hard budgets (transitions, tokens, USD, wall clock); at most 2 patch attempts per failure fingerprint (normalized message, so paths and line numbers do not matter); cycle detection on `(state, tree root, fingerprint)`; a lexicographic progress score `(compile errors, failing tests)` with rollback to the best tree after 3 non-improving steps.
- **Context:** a tiered prompt (pinned 15%, working set 45%, live failure 25%, ledger 15%). History is a template-built ledger, not an LLM summary, so negative knowledge ("tried X, failed because Y") is never silently dropped. Every prompt is hashed for replay.
- **Persistence:** append-only, hash-partitioned `run_events` with row-level security; one writer per `(run, branch)`; the **fencing token is enforced in Postgres**, so a zombie worker with an expired Redis lease cannot write.

### 2. Sandbox and MCP server
`src/sandbox/*` `src/mcp/server.ts` · [design doc](docs/sandbox.md)

- **gVisor (`runsc`)** puts a user-space kernel between generated code and the host. `CapDrop: ALL`, `no-new-privileges`, non-root, read-only rootfs, tmpfs workspace, no network, 0.5 vCPU, 512 MiB with swap disabled, PID limit, no core dumps.
- A **zero-dependency Docker Engine client** over the unix socket, including the HTTP connection hijack for `exec/start`.
- **Stream demultiplexer** for Docker's framed stdout/stderr, correct at every chunk boundary, with `await`-per-frame backpressure to the daemon.
- Two layers of timeout (`timeout -k` inside, a host timer that kills the container outside); output floods are cut and the container is killed; PID 1 is `sleep <ttl>` so orphans expire on their own.
- Tenant and run identity come from the orchestrator's environment, **never from model-supplied tool arguments**.

### 3. Exactly-once external actions
`src/jobs/*` · [design doc](docs/jobs.md)

BullMQ gives at-least-once delivery. A **write-ahead ledger in Postgres plus provider-side idempotency tokens** turn that into exactly-once *effect*.

```mermaid
sequenceDiagram
  participant W as Worker
  participant L as Ledger (Postgres)
  participant P as Provider
  W->>L: begin(key): atomic INTENT and lease
  L-->>W: started, attempt 1
  W->>P: create(token = key)
  P-->>W: resource created
  W-xL: succeed(key) fails, database down
  Note over W: job fails, row stays INTENT or UNKNOWN
  W->>L: begin(key) on retry
  L-->>W: resumed, attempt 2
  W->>P: lookup(token) or create(token = key)
  P-->>W: same resource, deduplicated
  W->>L: succeed(key, attempt 2)
```

- Key = `sha256(tenant, run, step, action, canonical params)`, **never including the retry attempt**. The same key is the ledger primary key and the provider token.
- Errors are classified so that **ambiguous** outcomes (timeouts, resets, 5xx: the request may have executed) are resolved by token or lookup, never by blind retry.
- Every ledger write after `begin()` is fenced by attempt number; leases use the database clock and are heartbeated, and an in-flight call is aborted if the lease is lost.
- An **AWS EC2 adapter** (`src/providers/aws`, [docs/aws.md](docs/aws.md)): the ledger key is the `ClientToken`, a tag carries it for crash recovery, a cost allowlist guards instance types, and AWS errors map onto the retry classes.
- Full-jitter backoff honoring `Retry-After`, per-provider circuit breaker, bounded queue with admission control, DLQ triage (redrive, reconcile first, quarantine, or escalate), and an **orphan reconciler** with a blast-radius cap.

### 4. Compliance boundary and fix cache
`src/compliance/*` `src/cache/*` · [design doc](docs/compliance.md)

- A **streaming scrubber** redacts keys, tokens, private keys, URL credentials, emails, phone numbers, cards (Luhn), SSNs and US-style addresses. Output **does not depend on how the input is chunked** (verified at every two-way split, including inside multi-byte characters, plus byte-at-a-time and random chunking), memory is bounded, and patterns use bounded quantifiers and are tested against 1 MB adversarial inputs.
- It runs **before truncation** and before anything leaves the trust boundary. Placeholders carry a salted HMAC tag, so repeats correlate without enabling a dictionary attack.
- The **fix cache** lets one agent reuse another's verified fix: exact fingerprint first, then pgvector similarity behind hard gates (tenant, tool, error code, language, toolchain). Confidence uses a Wilson lower bound, bad entries quarantine themselves, and a hit is only a *candidate* that still passes compile and test.
- Embedding input must be a `Scrubbed` type: unscrubbed text does not compile. Embedders behind one interface (lexical baseline, a local ONNX model, any OpenAI-compatible endpoint); the cache degrades to a miss if the embedder or database fails. [docs/embeddings.md](docs/embeddings.md) reports a retrieval benchmark and why the default thresholds need calibrating per embedder.

## Guarantees and the evidence behind them

| Guarantee | Evidence |
|---|---|
| State transitions are deterministic; loops, oscillation, stalls and budget overruns terminate | Unit tests in `test/reducer.test.ts` |
| A crash after a provider call, or a lost ledger write, cannot create a second resource | Crash-matrix tests in `test/jobs.test.ts` (native token, lookup, DB fully down, ambiguous timeout) |
| Concurrent duplicates execute once; a stale worker cannot overwrite the new owner | `test/jobs.test.ts` (in-memory ledger mirroring the SQL) |
| Docker stream demux is correct at any chunk boundary; floods and hangs are contained | `test/sandbox.test.ts` against an in-process fake daemon |
| Isolation parameters reach the Docker API | `test/sandbox.test.ts` asserts the create body (this does **not** prove runtime isolation) |
| Secrets and PII covered by the detectors are redacted regardless of chunk boundaries | `test/compliance.test.ts` (every two-way split, byte-at-a-time, random chunking, 300 KB line) |
| Tenants cannot read or influence each other's cached fixes | `test/cache.test.ts` (in-memory reference store) |
| Zombie writer rejected by Postgres fencing; Redis counter loss cannot lock a run out | `test/integration/fencing.itest.ts` (CI job `integration`) |
| Ledger SQL behaves exactly like the in-memory reference | Differential test over 1,250 random operations, `test/integration/ledger.itest.ts` |
| Sandbox is unprivileged, read-only, networkless, limited, and cleaned up | `test/integration/docker.itest.ts` against a real daemon (CI jobs `docker`, `gvisor`) |

## Status: what is and is not verified

All six CI jobs pass on the latest run:
- typecheck and 102 unit tests;
- 36 integration tests against real Postgres 16 with pgvector and Redis 7;
- the 14-test sandbox suite against a real Docker daemon, and again under gVisor (`runsc`). The sandbox manager fails closed if the requested runtime is not registered, so a green run means the containers really ran under gVisor;
- 5 tests of the AWS EC2 adapter, using the real AWS SDK against the `moto` emulator;
- a real local embedding model on a retrieval benchmark (4 tests).

The newest jobs (`gvisor`, `aws-emulator`, `embeddings`) are still configured as allowed-to-fail until they have proven stable.
[docs/testing.md](docs/testing.md) explains what each tier checks, and [docs/what-the-tests-found.md](docs/what-the-tests-found.md) is a log of **twelve defects the tests exposed**, including a fencing module that had never executed, a Redis counter reset that could lock a run out forever, and a Docker upload API that cannot work with a read-only root filesystem.

**Measured, and worth knowing**
- The `moto` emulator does **not** enforce EC2's ClientToken idempotency (the CI log says so). EC2's real behavior is checked only by an opt-in live test (`npm run test:aws-live`) that **has not been run**; until then the deduplication claim rests on AWS's documentation.
- On the 32-item fix-class benchmark the real embedding model ties the lexical baseline on recall@1 (0.875) and serves fewer correct repeats at equal precision (4 versus 9 of 48 pairs at precision >= 0.95), while being clearly better at natural-language paraphrase (cosine 0.93 versus 0.25 for an unrelated error). The set is small, so this is "no evidence the model is better here", not a verdict. The default stays lexical; see [docs/embeddings.md](docs/embeddings.md).

Caveats: capability, cgroup-limit and OOM assertions run on runc only (gVisor reports its own view of those); the cgroup and swap checks skip themselves if the files are absent; timing-based tests could flake on a very slow runner.

Not verified: behavior under network partitions, performance and ANN recall at scale, and any real cloud account.
Other known limits: the scrubber does not detect names, non-US addresses or encoded secrets; detector and cache thresholds need tuning on real data. Each design doc ends with its own list of gaps.

## Quick start

```bash
npm install
npm run typecheck
npm test                      # unit tests; Node >= 22.6 (uses --experimental-strip-types)

# integration tests need Postgres+pgvector and Redis (they drop tables and flush Redis, so use the compose file):
docker compose -f docker-compose.integration.yml up -d
export NEXUS_ITEST=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres REDIS_URL=redis://localhost:6379
npm run test:integration
NEXUS_DOCKER_ITEST=1 npm run test:docker       # sandbox suite against your local Docker (add NEXUS_RUNTIME=runsc for gVisor)
```

Run the sandbox MCP server (needs Docker with gVisor; see [docs/sandbox.md](docs/sandbox.md)):

```bash
docker build -t nexus-sandbox:latest -f docker/sandbox.Dockerfile .
NEXUS_TENANT_ID=<tenant> NEXUS_RUN_ID=<run> npm run start:mcp
# local development without gVisor: add NEXUS_ALLOW_RUNC_FALLBACK=1
```

## Repository layout

```
src/
  reducer.ts fingerprint.ts context.ts types.ts   state machine, failure identity, prompt assembly
  store.ts driver.ts                              Postgres event log, Redis leases, write path
  sandbox/    policy client demux sandbox manager semaphore tar capture
  mcp/        server.ts                           MCP tools: write_files, exec, reset
  jobs/       idempotency ledger pgLedger runner errors backoff breaker dlq reconciler queues
  compliance/ detectors scrubber
  cache/      embedder store pgStore fixCache eval  (embedders/: transformers, openaiCompatible)
  providers/aws/ ec2 sdk awsErrors
test/         one file per module, plus a fake Docker daemon in test/helpers
  integration/ tests against real Postgres, Redis, Docker (skipped unless enabled)
docs/         sandbox.md  jobs.md  compliance.md  testing.md  embeddings.md  aws.md  what-the-tests-found.md
docker/       sandbox.Dockerfile
```

## Roadmap

1. Run the live AWS test once and record the result; build a retrieval benchmark from real run logs (including prose-like failures) and try a hybrid lexical and semantic score.
2. Measure gVisor overhead; add network-partition and chaos tests; make the gVisor job blocking once it has proven stable.
3. Load and recall benchmarks for the ledger and the pgvector cache; a larger, real-log retrieval benchmark.
4. An NER pass for names and non-US addresses; cache staleness and invalidation policy.
5. More provider adapters (Vercel, GitHub) on the same action interface, and metrics and tracing.

## License

MIT
