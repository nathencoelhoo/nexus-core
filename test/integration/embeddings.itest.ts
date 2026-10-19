import { before } from 'node:test';
import assert from 'node:assert/strict';
import { itest } from './_helpers.ts';
import { TransformersEmbedder } from '../../src/cache/embedders/transformers.ts';
import { HashingEmbedder, cosine } from '../../src/cache/embedder.ts';
import { FixCache } from '../../src/cache/fixCache.ts';
import type { FailureCtx } from '../../src/cache/fixCache.ts';
import { DEFAULT_CACHE_POLICY, MemoryFixCacheStore } from '../../src/cache/store.ts';
import { bestThreshold, evaluateRetrieval, thresholdSweep } from '../../src/cache/eval.ts';
import { asScrubbed } from '../../src/compliance/scrubber.ts';
import { FAILURE_CLUSTERS } from '../fixtures/failure-clusters.ts';

/**
 * Runs a real sentence-embedding model locally (downloads about 25 MB on first use), so it has its own CI job and is
 * skipped unless NEXUS_EMBED_ITEST=1 and @huggingface/transformers is installed. It REPORTS numbers; the assertions are
 * sanity floors that detect a broken setup (wrong pooling, wrong dimension), not claims that the model beats the baseline.
 */
const ENABLED = process.env.NEXUS_EMBED_ITEST === '1';
const emb = new TransformersEmbedder();
if (ENABLED) before(async () => { await emb.warmup(); }, { timeout: 300_000 });
const etest = (name: string, fn: () => Promise<void>) => itest(name, fn, ENABLED);
const S = asScrubbed;
const THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.92, 0.95, 0.97];

etest('produces unit-norm vectors of the configured dimension, deterministically', async () => {
  const [a, b, a2] = await emb.embed([S('Property x does not exist on type Y.'), S('Cannot find module react.'), S('Property x does not exist on type Y.')]);
  assert.equal(a!.length, 384);
  assert.ok(Math.abs(Math.hypot(...a!) - 1) < 1e-3);
  assert.ok(cosine(a!, a2!) > 0.9999);
  assert.ok(cosine(a!, b!) < 0.99);
});

etest('a paraphrase is closer than an unrelated error', async () => {
  const [q, para, other] = await emb.embed([
    S("Property 'name' does not exist on type 'User'."),
    S("Type 'User' has no property called 'name'."),
    S("Cannot find module 'react' or its corresponding type declarations."),
  ]);
  const [near, far] = [cosine(q!, para!), cosine(q!, other!)];
  console.log('paraphrase', near.toFixed(3), 'unrelated', far.toFixed(3));
  assert.ok(near > far + 0.1, `paraphrase ${near} vs unrelated ${far}`);
});

etest('fix-class benchmark: report the model against the lexical baseline', async () => {
  const [model, base] = [await evaluateRetrieval(emb, FAILURE_CLUSTERS), await evaluateRetrieval(new HashingEmbedder(256), FAILURE_CLUSTERS)];
  const [mSweep, bSweep] = [await thresholdSweep(emb, FAILURE_CLUSTERS, THRESHOLDS), await thresholdSweep(new HashingEmbedder(256), FAILURE_CLUSTERS, THRESHOLDS)];
  const fmt = (r: typeof model) => ({ recallAt1: +r.recallAt1.toFixed(3), mrr: +r.mrr.toFixed(3), sameMean: +r.sameMean.toFixed(3), diffMean: +r.diffMean.toFixed(3), margin: +r.margin.toFixed(3) });
  console.log('MODEL    ', JSON.stringify(fmt(model)));
  console.log('BASELINE ', JSON.stringify(fmt(base)));
  console.log('threshold  model(precision/recall)   baseline(precision/recall)');
  mSweep.forEach((m, i) => console.log(`${m.threshold.toFixed(2)}       ${m.precision.toFixed(2)} / ${m.recall.toFixed(2)}            ${bSweep[i]!.precision.toFixed(2)} / ${bSweep[i]!.recall.toFixed(2)}`));
  console.log('best threshold at precision >= 0.95  model:', JSON.stringify(bestThreshold(mSweep, 0.95)), ' baseline:', JSON.stringify(bestThreshold(bSweep, 0.95)));
  assert.equal(model.items, 32);
  assert.ok(model.recallAt1 >= 0.6, `recall@1 ${model.recallAt1}`);
  assert.ok(model.margin > 0.05, `margin ${model.margin}`);
});

etest('works end to end through FixCache with the real model (flow, not accuracy)', async () => {
  const errors: string[] = [];
  const cache = new FixCache(new MemoryFixCacheStore(), emb, { ...DEFAULT_CACHE_POLICY, minSimilarity: 0.8, minSimilarityUntested: 0.8, embedTimeoutMs: 30_000 }, { onError: e => { errors.push(e.message); } });
  const ctx = (fp: string, message: string): FailureCtx => ({ tenantId: 't', fp, tool: 'tsc', code: 'TS2322', lang: 'ts', toolchain: 'tsc@5.6.3', message: S(message), contextSha: 'c' });
  const patch = { diff: S('--- a\n+++ b\n'), files: ['x.ts'], contextSha: 'c', containsRedaction: false };
  assert.ok(await cache.learn({ ctx: ctx('f1', FAILURE_CLUSTERS[0]!.text), patch, resolved: true, before: [3, 0], after: [0, 0] }));
  const d = await cache.find(ctx('f2', FAILURE_CLUSTERS[1]!.text));          // same cluster, different fingerprint
  assert.deepEqual(errors, []);
  assert.ok(d.kind === 'hit' || (d.kind === 'miss' && d.reason !== 'embedder_error' && d.reason !== 'store_error'));
});
