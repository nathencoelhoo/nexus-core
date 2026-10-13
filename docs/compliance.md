# Compliance proxy and fix cache (Section 4)

## Where the boundary is
Scrubbing runs in the **control plane** (the MCP server process, between the sandbox and the model API), not inside
the container. The sandbox is untrusted; the control plane is trusted. The guarantee is: *nothing reaches the LLM or an
embedding API without passing the scrubber*. Data does reach the control plane unscrubbed, so control-plane logs must
not record raw sandbox output.

## What is scrubbed, and where
| Path | Mechanism |
|---|---|
| Sandbox stdout/stderr to model | `Sandbox.exec({ scrub })`, streaming, one scrubber per stream, **before** head+tail capture |
| Prompt assembly (files, diagnostics, ledger) | `assemblePrompt(..., scrub)`, applied to every tier **before** truncation |
| Fix-cache keys and stored patches | `Scrubbed` brand type: the embedder and store only accept scrubbed text (compile-time) |
| Failure fingerprints | Placeholder tags are normalized away, so two failures differing only in a redacted value share a fingerprint |

Order matters: truncating first can cut a secret in half and leave a fragment no pattern can match.

## Streaming scrubber guarantees
- **No match is split across emitted output.** Text is released at line boundaries; a partial line is held until its newline, a force-emit, or `flush()`. A force-emit (line longer than `maxLine`, 64 KiB) always retains an `overlap` tail (8 KiB, larger than the longest bounded match), and never cuts through a completed match.
- **Output is independent of chunking.** Tested for every two-way split of a mixed document (including inside multi-byte characters), byte-at-a-time, 50 random chunkings, and a 300 KB single line across four chunk sizes.
- **Bounded memory:** `maxLine + chunk`. Multi-byte characters split across chunks are reassembled (`StringDecoder`).
- **Fails closed:** an unterminated private-key block is redacted at flush; an oversized one is cut at 64 KiB.
- **Placeholders** are `[REDACTED:<kind>:<tag>]`, where the tag is a truncated HMAC with a per-run salt. Repeats correlate within a run (the model can see two references are the same value) without enabling a dictionary attack on low-entropy values like phone numbers.
- **ReDoS-safe by construction:** every quantifier is bounded, no pattern crosses `\n`, and 1 MB adversarial inputs are in the test suite.

## Detectors
Secrets: private keys (block and inline), AWS key id and secret, GitHub, Stripe, Slack, Anthropic, OpenAI-style, Google API keys,
JWTs, Authorization headers, URL credentials, and a keyword-plus-entropy `secret_assignment`.
PII: email, SSN (with validity rules), credit cards (Luhn), phone numbers, US-style street addresses.

Cheap per-detector pre-filters skip regexes that cannot match a line. Overlapping matches are unioned (never leaving a tail),
named by detector priority.

### False positives are a deliberate trade-off
`secret_assignment`, `phone` and `street_address` trade precision for recall: redacting a harmless value costs the model a
little context; missing a real one is a leak. Mitigations in the code: entropy gates, placeholder and code-expression
rejection (`process.env.X`, `getPassword()`), letters-only values need length 16+, date/IPv4/epoch/UUID exclusions for phones,
`git@` and example domains for email. Expect to tune these on your own logs.

## What it does NOT do
- **Names and non-US addresses.** Regexes cannot recognize them. Use an NER or classifier pass if your compliance regime requires it.
- **Encoded secrets** (base64 of a key, split across string concatenation in source) are not detected.
- **Novel credential formats** without a recognizable prefix or keyword are caught only by the entropy heuristic.
- **Inbound direction** (model output to sandbox) is not scrubbed, and there is no reversible tokenization vault. A detokenizer would itself be an exfiltration path and needs its own threat model.
- Daemon error strings returned by `exec` are not scrubbed.
- Pattern matching is a control, not a proof. It reduces leakage; it does not certify compliance.

## Fix cache (pgvector)
Goal: when Agent B hits a failure Agent A already fixed, skip the LLM call.

**Two tiers.** (1) Exact: the Section 1 failure fingerprint, an index lookup with no embedding call. (2) Semantic: cosine ANN over the
normalized, scrubbed message, behind hard gates.

**Hard gates (exact match in SQL before similarity is considered):** tenant, tool, error code, language, toolchain version, embedding model.
Vectors from different models are never compared. Tool, code and language are deliberately *not* in the embedded text (repeating
them inflated similarity of unrelated failures from 0.25 to 0.40 in measurement).

**Confidence.** An entry that has never failed needs near-identity (similarity >= 0.97). An entry with a track record may match at
>= 0.92, but only if its Wilson lower bound on success rate is >= 0.4, so 1 success of 1 is not trusted like 20 of 20.
Recording a success can never make an entry *less* eligible (this was a bug in my first draft, caught while writing tests).
Three failures with failures > successes quarantine an entry; relearning a quarantined fingerprint replaces it and resets its record.

**A hit is a candidate, not a verdict.** `apply_verbatim` only when the code region hash matches and scrubbing did not alter the diff;
otherwise `hint_llm` (the model gets the cached patch as a starting point). Either way the patch goes through the normal
Compile and Test states with all Section 1 guards. Only a fix that resolved its fingerprint and strictly improved the score is ever stored (`learn()`).

**Stampede control.** `resolve()` coalesces concurrent identical failures so exactly one generation runs (in-process; use a Redis lock across processes).

**Tenant isolation.** Per-tenant only, enforced three ways: the WHERE clause, the index, and row-level security with `app.tenant_id` bound per
transaction. Outcome reports from another tenant are ignored. A shared cross-tenant tier is intentionally not built: it would need provenance
checks, since a poisoned entry would then propagate across customers.

**pgvector notes.** HNSW with filters can return fewer than k rows because the filter applies after the index scan; the store sets
`hnsw.iterative_scan = relaxed_order` and a higher `ef_search` per transaction (needs pgvector >= 0.8; pass `iterativeScan: false` on older versions).
Dimension is fixed in the DDL and must equal `Embedder.dim`.

**Embedder.** `HashingEmbedder` is a lexical baseline for offline use and tests, not a semantic model. Production needs a real model behind the
`Embedder` interface; its input type is `Scrubbed`, so unscrubbed text does not compile.

## Known gaps
- `PgFixCacheStore` and the scrubber's behavior on real production logs are untested against a real database or real data. `MemoryFixCacheStore` mirrors the SQL semantics and is what the unit tests use.
- Thresholds (0.92, 0.97, 0.4) are starting points; tune them from replayed audit data, as with the Section 1 guards.
- No staleness policy yet (age-based expiry, invalidation on toolchain or lockfile change beyond the exact `toolchain` gate).
- No benchmark of ANN recall or latency.
