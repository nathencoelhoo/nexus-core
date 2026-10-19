import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatibleEmbedder, EmbeddingError } from '../src/cache/embedders/openaiCompatible.ts';
import { HashingEmbedder, cosine } from '../src/cache/embedder.ts';
import { FixCache } from '../src/cache/fixCache.ts';
import type { FailureCtx } from '../src/cache/fixCache.ts';
import { DEFAULT_CACHE_POLICY, MemoryFixCacheStore } from '../src/cache/store.ts';
import type { FixCacheStore, FixPatch } from '../src/cache/store.ts';
import { evaluateRetrieval } from '../src/cache/eval.ts';
import { FAILURE_CLUSTERS } from './fixtures/failure-clusters.ts';
import { asScrubbed } from '../src/compliance/scrubber.ts';
import type { Scrubbed } from '../src/compliance/scrubber.ts';
import type { Embedder } from '../src/cache/embedder.ts';

// ---- a fake /v1/embeddings server --------------------------------------------------------------------------------
type Mode = 'ok' | 'reversed' | 'scaled' | 'wrong-dim' | 'short' | 'bad-number' | 'http500' | 'echo-key' | 'hang';
let server: http.Server; let base = '';
let mode: Mode = 'ok';
const requests: Array<{ headers: http.IncomingHttpHeaders; body: { model: string; input: string[]; dimensions?: number } }> = [];
const DIM = 64;
const lexical = new HashingEmbedder(DIM);

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      if (req.url !== '/v1/embeddings' || req.method !== 'POST') { res.statusCode = 404; res.end('{}'); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ headers: req.headers, body });
      if (mode === 'hang') return;
      if (mode === 'http500') { res.statusCode = 500; res.end('internal error'); return; }
      if (mode === 'echo-key') { res.statusCode = 401; res.end(`bad key ${String(req.headers.authorization)}`); return; }
      const vecs = await lexical.embed(body.input.map((s: string) => asScrubbed(s)));
      let data = vecs.map((v, index) => ({ index, embedding: Array.from(v) }));
      if (mode === 'scaled') data = data.map(d => ({ ...d, embedding: d.embedding.map(x => x * 7) }));
      if (mode === 'wrong-dim') data = data.map(d => ({ ...d, embedding: d.embedding.slice(0, 10) }));
      if (mode === 'short') data = data.slice(1);
      if (mode === 'bad-number') data = data.map(d => ({ ...d, embedding: d.embedding.map((x, i) => (i === 3 ? 'NaN' : x)) as unknown as number[] }));
      if (mode === 'reversed') data = [...data].reverse();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });

const mk = (o: Partial<ConstructorParameters<typeof OpenAICompatibleEmbedder>[0]> = {}) =>
  new OpenAICompatibleEmbedder({ baseUrl: base, model: 'embed-x', dim: DIM, apiKey: 'sk-test-key-123', timeoutMs: 2000, ...o });
const S = (s: string) => asScrubbed(s);
const run = async (m: Mode, fn: () => Promise<void>) => { mode = m; requests.length = 0; await fn(); };

// ---- OpenAI-compatible embedder -----------------------------------------------------------------------------------
test('request shape: auth header, model, input array; `dimensions` only when asked', () => run('ok', async () => {
  await mk().embed([S('a'), S('b')]);
  assert.equal(requests[0]!.headers.authorization, 'Bearer sk-test-key-123');
  assert.deepEqual(requests[0]!.body, { model: 'embed-x', input: ['a', 'b'] });
  requests.length = 0;
  await mk({ requestDimensions: true }).embed([S('a')]);
  assert.equal(requests[0]!.body.dimensions, DIM);
}));

test('results come back in input order even if the server reorders them by index', () => run('reversed', async () => {
  const texts = ['alpha beta', 'gamma delta', 'epsilon zeta'].map(S);
  const got = await mk().embed(texts);
  const want = await lexical.embed(texts);
  got.forEach((v, i) => assert.ok(cosine(v, want[i]!) > 0.9999, `item ${i}`));
}));

test('batching: 150 inputs, batch size 64 -> 3 requests, one result each', () => run('ok', async () => {
  const got = await mk({ batchSize: 64 }).embed(Array.from({ length: 150 }, (_, i) => S(`text number ${i}`)));
  assert.equal(got.length, 150);
  assert.deepEqual(requests.map(r => r.body.input.length), [64, 64, 22]);
}));

test('vectors are L2-normalized regardless of what the server returns', () => run('scaled', async () => {
  const [v] = await mk().embed([S('anything at all')]);
  let n = 0; for (const x of v!) n += x * x;
  assert.ok(Math.abs(Math.sqrt(n) - 1) < 1e-5);
}));

test('malformed responses are rejected, not silently stored', async () => {
  for (const [m, re] of [['wrong-dim', /not 64 finite numbers/], ['short', /expected 2 embeddings, got 1/], ['bad-number', /not 64 finite numbers/]] as const) {
    await run(m, async () => { await assert.rejects(mk().embed([S('a'), S('b')]), (e: unknown) => e instanceof EmbeddingError && re.test(e.message), m); });
  }
});

test('HTTP errors carry the status but never the response body or the API key', async () => {
  await run('http500', async () => {
    await assert.rejects(mk().embed([S('a')]), (e: unknown) => e instanceof EmbeddingError && e.status === 500 && !/internal error/.test(e.message));
  });
  await run('echo-key', async () => {
    await assert.rejects(mk().embed([S('a')]), (e: unknown) =>
      e instanceof EmbeddingError && e.status === 401 && !e.message.includes('sk-test-key-123'));
  });
});

test('a hung endpoint times out', () => run('hang', async () => {
  await assert.rejects(mk({ timeoutMs: 100 }).embed([S('a')]), /timed out after 100ms/);
}));

test('endpoint safety: https required except loopback; no credentials in the URL', () => {
  assert.throws(() => mk({ baseUrl: 'http://embeddings.example.com/v1' }), /https/);
  assert.throws(() => mk({ baseUrl: 'https://user:pw@embeddings.example.com/v1' }), /credentials/);
  mk({ baseUrl: 'https://embeddings.example.com/v1' });
  mk({ baseUrl: 'http://localhost:11434/v1' });
});

test('very long diagnostics are truncated before they are sent; the model id includes the dimension', () => run('ok', async () => {
  await mk({ maxChars: 100 }).embed([S('x'.repeat(5000))]);
  assert.equal(requests[0]!.body.input[0]!.length, 100);
  assert.equal(mk().model, 'openai-compatible:embed-x:64');
  assert.notEqual(mk({ dim: 128 }).model, mk().model);
}));

// ---- the cache is an optimization, never a dependency --------------------------------------------------------------
const ctx = (o: Partial<FailureCtx> = {}): FailureCtx => ({
  tenantId: 'tenant-a', fp: 'fp1', tool: 'tsc', code: 'TS2322', lang: 'ts', toolchain: 'tsc@5.6.3',
  message: S("Type 'string' is not assignable to type 'number'."), contextSha: 'c1', ...o,
});
const patch = (): FixPatch => ({ diff: S('--- a\n+++ b\n'), files: ['x.ts'], contextSha: 'c1', containsRedaction: false });

class ToggleEmbedder implements Embedder {
  readonly model = 'toggle'; readonly dim = 64;
  mode: 'ok' | 'fail' | 'slow' | 'slow-reject' = 'ok';
  async embed(texts: Scrubbed[]): Promise<Float32Array[]> {
    if (this.mode === 'fail') throw new Error('embedding service down');
    if (this.mode === 'slow') { await new Promise(r => setTimeout(r, 300)); }
    if (this.mode === 'slow-reject') { await new Promise(r => setTimeout(r, 80)); throw new Error('rejected after the timeout already won'); }
    return lexical.embed(texts);
  }
}

test('embedder down: exact hits still work, semantic lookups miss with a reason, resolve() falls through to the model, learn() never throws', async () => {
  const emb = new ToggleEmbedder();
  const errors: string[] = [];
  const cache = new FixCache(new MemoryFixCacheStore(), emb, DEFAULT_CACHE_POLICY, { onError: (e, op) => { errors.push(`${op}:${e.message}`); } });
  assert.ok(await cache.learn({ ctx: ctx(), patch: patch(), resolved: true, before: [3, 0], after: [0, 0] }));

  emb.mode = 'fail';
  const exact = await cache.find(ctx());
  assert.ok(exact.kind === 'hit' && exact.tier === 'exact');               // no embedding needed
  assert.deepEqual(await cache.find(ctx({ fp: 'other' })), { kind: 'miss', reason: 'embedder_error' });
  let generated = 0;
  const r = await cache.resolve(ctx({ fp: 'other2' }), async () => { generated++; return patch(); });
  assert.equal(r.source, 'llm'); assert.equal(generated, 1);
  assert.equal(await cache.learn({ ctx: ctx({ fp: 'x' }), patch: patch(), resolved: true, before: [3, 0], after: [0, 0] }), null);
  assert.ok(errors.length >= 3 && errors.every(e => /embedding service down/.test(e)), errors.join('|'));
});

test('a slow embedder is a miss, and its late failure is not an unhandled rejection', async () => {
  const emb = new ToggleEmbedder();
  const cache = new FixCache(new MemoryFixCacheStore(), emb, { ...DEFAULT_CACHE_POLICY, embedTimeoutMs: 30 });
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const m of ['slow', 'slow-reject'] as const) {
      emb.mode = m;
      assert.deepEqual(await cache.find(ctx({ fp: `s-${m}` })), { kind: 'miss', reason: 'embedder_error' });
    }
    await new Promise(r => setTimeout(r, 400));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('database down: lookups miss, learning and reporting degrade silently', async () => {
  const boom = async () => { throw new Error('connection refused'); };
  const store: FixCacheStore = { getExact: boom, search: boom, upsert: boom, recordOutcome: boom };
  const errors: string[] = [];
  const cache = new FixCache(store, new HashingEmbedder(64), DEFAULT_CACHE_POLICY, { onError: (_e, op) => { errors.push(op); } });
  assert.deepEqual(await cache.find(ctx()), { kind: 'miss', reason: 'store_error' });
  assert.equal(await cache.learn({ ctx: ctx(), patch: patch(), resolved: true, before: [3, 0], after: [0, 0] }), null);
  await cache.report('tenant-a', '1', true);
  assert.deepEqual(errors, ['find', 'learn', 'report']);
});

// ---- retrieval benchmark: the baseline is pinned so a regression (or an improvement) is visible -----------------------
test('lexical baseline on the fix-class benchmark (32 real TypeScript diagnostics, 3 groups)', async () => {
  const r = await evaluateRetrieval(new HashingEmbedder(256), FAILURE_CLUSTERS);
  console.log('baseline', JSON.stringify({ recallAt1: +r.recallAt1.toFixed(3), mrr: +r.mrr.toFixed(3), sameMean: +r.sameMean.toFixed(3), diffMean: +r.diffMean.toFixed(3), margin: +r.margin.toFixed(3) }));
  assert.equal(r.items, 32);
  assert.ok(r.recallAt1 >= 0.8, `recall@1 ${r.recallAt1}`);
  assert.ok(r.mrr >= 0.85, `mrr ${r.mrr}`);
  // The calibration finding: same-fix similarity sits far below the default semantic threshold, so with this embedder the
  // semantic tier would almost never fire. A real model has to open that gap (see docs/embeddings.md).
  assert.ok(r.sameMean < DEFAULT_CACHE_POLICY.minSimilarity);
});

test('thresholdSweep / bestThreshold compute precision and recall correctly on hand-made vectors', async () => {
  const v = (x: number, y: number) => { const n = Math.hypot(x, y); return Float32Array.from([x / n, y / n]); };
  const table: Record<string, Float32Array> = { a1: v(1, 0), a2: v(0.9, 0.1), b1: v(0, 1), b2: v(0.1, 0.9), c1: v(0.7, 0.7) };
  const fixed: Embedder = { model: 'fixed', dim: 2, embed: async ts => ts.map(t => table[t]!) };
  const data = [
    { group: 'g', cluster: 'A', text: 'a1' }, { group: 'g', cluster: 'A', text: 'a2' },
    { group: 'g', cluster: 'B', text: 'b1' }, { group: 'g', cluster: 'B', text: 'b2' },
    { group: 'g', cluster: 'C', text: 'c1' },
  ];
  const { thresholdSweep, bestThreshold } = await import('../src/cache/eval.ts');
  const rows = await thresholdSweep(fixed, data, [0.0, 0.99, 0.999]);
  assert.deepEqual(rows.map(r => r.hits), [10, 2, 0]);                       // 10 pairs; a1-a2 and b1-b2 are > 0.99
  assert.deepEqual([rows[0]!.precision, rows[0]!.recall], [0.2, 1]);          // everything served: 2 of 10 correct, all positives found
  assert.deepEqual([rows[1]!.precision, rows[1]!.recall], [1, 1]);
  assert.equal(rows[2]!.precision, 1);                                        // nothing served counts as vacuously precise...
  assert.equal(rows[2]!.recall, 0);                                           // ...and useless
  assert.deepEqual(bestThreshold(rows, 0.95)?.threshold, 0.99);               // a zero-hit row is never "best"
  assert.equal(bestThreshold(rows.slice(0, 1), 0.95), null);
});
