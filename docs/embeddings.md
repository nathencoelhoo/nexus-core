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

### The real model

`npm run test:embeddings` (CI job `embeddings`) runs `TransformersEmbedder` on the same benchmark and prints the model and baseline side by side,
with both threshold tables. **Those numbers have not been measured yet**; this document will be updated from the first CI run. The test asserts only
sanity floors (recall@1 >= 0.6, positive margin) that detect a broken setup such as wrong pooling or dimension. It does not assert that the model beats
the baseline, because that is a result to report, not a claim to presume.

### Choosing a threshold

Pick the highest-recall threshold whose precision is at least 0.95 (`bestThreshold`). Precision matters more than recall: a wrong cached patch costs a
compile-and-test cycle and counts against the loop budget, while a missed hit only costs one LLM call.

## Operating notes

- `cacheDdl(embedder.dim)` fixes the vector dimension. `PgFixCacheStore.verifyDimension(dim)` checks it at startup instead of failing on the first insert.
- Every row stores `embed_model`, and lookups only compare vectors from the same model. Switching models orphans old rows (they are never matched); re-embed or start fresh.
- Latency and cost: the local model adds CPU time per lookup and a one-time download; a hosted model adds network latency, a per-call cost and egress.

## Known limits

- The benchmark is small (32 texts), synthetic in construction (real messages, hand-labelled fix classes) and covers one tool. Treat results as a smoke test and a calibration aid, not a proof.
- No code-specialized embedding model was evaluated; the default is a general English sentence model.
- Fix classes were labelled by hand. Real validation needs logs from real runs and the real outcome of cached patches (the cache already records successes and failures per entry).
