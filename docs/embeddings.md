# Embeddings for the fix cache

## What exists

| Embedder | Where it runs | Egress | Use |
|---|---|---|---|
| `HashingEmbedder` | in process | none | Offline development and tests. Lexical, not semantic |
| `TransformersEmbedder` | in process, ONNX (`@huggingface/transformers`, default `Xenova/all-MiniLM-L6-v2`, 384 dimensions) | none after the first model download | Default for production when text must not leave the machine |
| `OpenAICompatibleEmbedder` | any server speaking `POST /embeddings` (OpenAI, Ollama, vLLM, LiteLLM) | **yes**: third-party egress | When a hosted model is worth the egress |

All three implement `Embedder`, whose input type is `Scrubbed`: unscrubbed text does not compile. The HTTP embedder additionally refuses
plain `http` except for loopback, refuses credentials embedded in the URL, truncates over-long input, validates every returned vector
(count, dimension, finite numbers, L2-normalizes), and never puts the API key or the response body in an error message.
`TransformersEmbedder` loads its package lazily and serializes calls; call `warmup()` at startup.

## The cache is an optimization, never a dependency

An embedding service outage, a slow model load or a database failure must not fail a run. `FixCache` therefore:
- serves **exact** fingerprint hits without embedding anything, so they keep working while the embedder is down;
- treats an embedder error, an embedder slower than `embedTimeoutMs` (default 3 s), or a store error as a **miss** with a reason
  (`embedder_error`, `store_error`), so `resolve()` falls through to the model;
- makes `learn()` and `report()` best effort (they never throw), and reports every failure to an optional `onError` hook;
- swallows the late result or late rejection of an embedding call whose timeout already won, so it can never become an unhandled rejection.

## Measuring instead of guessing

`src/cache/eval.ts` evaluates an embedder on `test/fixtures/failure-clusters.ts`: 32 real TypeScript diagnostics in 3 groups (the cache's exact-match gate:
tool + error code). Inside a group, texts belong to *fix classes* (for example "nullable value assigned to a non-null type" versus "missing property"
versus "primitive mismatch" under TS2322). The exact gates cannot separate those, so the embedding has to.

Metrics: recall@1 (is the nearest neighbour in the same fix class), MRR, mean similarity of same-fix and different-fix pairs, and a **threshold
sweep** (precision and recall of "serve a cached fix when cosine >= t").

### Baseline (`HashingEmbedder(256)`), measured

| Metric | Value |
|---|---|
| recall@1 | 0.875 |
| MRR | 0.908 |
| mean similarity, same fix class | 0.765 |
| mean similarity, different fix class | 0.652 |
| margin | 0.113 |

| threshold | precision | recall |
|---|---|---|
| 0.70 | 0.51 | 0.75 |
| 0.80 | 0.54 | 0.29 |
| 0.85 | 1.00 | 0.19 |
| 0.92 (the default `minSimilarity`) | 1.00 | 0.10 |
| 0.97 | 1.00 | 0.04 |

**Finding:** the baseline ranks well (recall@1 0.875) but its similarity scale is compressed, so at the default threshold of 0.92 it serves only about
10% of the fixable repeats. Ranking quality and threshold calibration are separate properties. Thresholds must be chosen per embedder from a sweep.

### The real model: measured

`TransformersEmbedder` (`Xenova/all-MiniLM-L6-v2`, 384 dimensions, local ONNX) on the same benchmark, from the `embeddings` CI job:

| | recall@1 | MRR | same-fix mean | different-fix mean | margin |
|---|---|---|---|---|---|
| Lexical baseline (`HashingEmbedder(256)`) | 0.875 | 0.908 | 0.765 | 0.652 | 0.113 |
| Local model | 0.875 | 0.928 | 0.583 | 0.462 | 0.121 |

Precision / recall of "serve a cached fix when cosine >= t":

| threshold | local model | lexical baseline |
|---|---|---|
| 0.60 | 0.57 / 0.42 | 0.39 / 1.00 |
| 0.70 | 0.74 / 0.29 | 0.51 / 0.75 |
| 0.75 | 0.78 / 0.15 | 0.60 / 0.38 |
| 0.80 | 1.00 / 0.08 | 0.54 / 0.29 |
| 0.85 | 1.00 / 0.08 | 1.00 / 0.19 |
| 0.92 (the default `minSimilarity`) | 1.00 / 0.08 | 1.00 / 0.10 |

Separately, on natural-language paraphrase the model is clearly strong: cosine 0.93 for a paraphrase of a TypeScript error versus 0.25 for an unrelated one.

**What this does and does not show**
- Ranking is a tie: identical recall@1, and an MRR difference of 0.02 is one or two items on a 32-item set. There are 48 same-fix pairs, so there are no confidence intervals worth quoting.
- At the operating point that matters (precision >= 0.95) the baseline serves about twice as many correct repeats: threshold 0.85 gives 9 of 48 pairs, against 4 of 48 for the model at 0.80.
- **Hypothesis, not tested:** the fix classes here differ by specific tokens (`undefined`, `null`, `missing`), which lexical features capture directly, while a general sentence model places all "type not assignable" diagnostics close together. A prose-like input (assertion messages, runtime exceptions, log lines) is where a semantic model should matter, and no benchmark here covers it.
- The model's similarity scale is lower than the baseline's, so the default threshold of 0.92 serves almost nothing for either. Thresholds must be set per embedder from a sweep.

**Decision:** for compiler diagnostics the lexical baseline stays the pragmatic default. It ties on ranking, is better at the high-precision operating point on this data, and costs no download, no ONNX runtime and no extra latency. `TransformersEmbedder` and the HTTP embedder remain available. Before preferring either, build a second benchmark from real run logs that includes prose-like failures; a hybrid of lexical and semantic scores is a reasonable experiment, with no result yet.

### Choosing a threshold

Pick the highest-recall threshold whose precision is at least 0.95 (`bestThreshold`). On this benchmark that is 0.85 for the baseline and 0.80 for the local model, both from only 48 same-fix pairs: treat them as starting points and recalibrate on real logs. Precision matters more than recall: a wrong cached patch costs a
compile-and-test cycle and counts against the loop budget, while a missed hit only costs one LLM call.

## Operating notes

- `cacheDdl(embedder.dim)` fixes the vector dimension. `PgFixCacheStore.verifyDimension(dim)` checks it at startup instead of failing on the first insert.
- Every row stores `embed_model`, and lookups only compare vectors from the same model. Switching models orphans old rows (they are never matched); re-embed or start fresh.
- Latency and cost: the local model adds CPU time per lookup and a one-time download; a hosted model adds network latency, a per-call cost and egress.

## Known limits

- The benchmark is small (32 texts), synthetic in construction (real messages, hand-labelled fix classes) and covers one tool. Treat results as a smoke test and a calibration aid, not a proof.
- No code-specialized embedding model was evaluated; the local model is a general English sentence model.
- Fix classes were labelled by hand. Real validation needs logs from real runs and the real outcome of cached patches (the cache already records successes and failures per entry).
