import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FixCache, buildKeyText } from '../src/cache/fixCache.ts';
import type { FailureCtx } from '../src/cache/fixCache.ts';
import { HashingEmbedder, cosine } from '../src/cache/embedder.ts';
import { MemoryFixCacheStore, wilsonLowerBound, DEFAULT_CACHE_POLICY } from '../src/cache/store.ts';
import type { FixPatch } from '../src/cache/store.ts';
import { asScrubbed } from '../src/compliance/scrubber.ts';
import { cacheDdl, vectorLiteral } from '../src/cache/pgStore.ts';

const embedder = new HashingEmbedder(256);
const msg = (s: string) => asScrubbed(s);
const ctx = (o: Partial<FailureCtx> = {}): FailureCtx => ({
  tenantId: 'tenant-a', fp: 'fp1', tool: 'tsc', code: 'TS2322', lang: 'ts', toolchain: 'tsc@5.6.3',
  message: msg("Type 'string' is not assignable to type 'number'."), contextSha: 'ctx-1', ...o,
});
const patch = (o: Partial<FixPatch> = {}): FixPatch => ({
  diff: asScrubbed('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-const n: number = "1";\n+const n: number = 1;\n'),
  files: ['x.ts'], contextSha: 'ctx-1', containsRedaction: false, ...o,
});
const learn = (c: FixCache, cx = ctx(), p = patch()) =>
  c.learn({ ctx: cx, patch: p, resolved: true, before: [3, 1e9], after: [0, 0] });
const mk = (policy = DEFAULT_CACHE_POLICY) => {
  const store = new MemoryFixCacheStore(policy.quarantineAfterFailures);
  return { store, cache: new FixCache(store, embedder, policy) };
};
const loose = { ...DEFAULT_CACHE_POLICY, minSimilarity: 0.8, minSimilarityUntested: 0.8 };

test('exact tier: fingerprint hit needs no embedding; verbatim only if the code region is identical', async () => {
  const { cache } = mk();
  await learn(cache);
  const same = await cache.find(ctx());
  assert.ok(same.kind === 'hit' && same.tier === 'exact' && same.mode === 'apply_verbatim');
  const moved = await cache.find(ctx({ contextSha: 'ctx-2' }));
  assert.ok(moved.kind === 'hit' && moved.mode === 'hint_llm');
});

test('a patch that contained redactions can only ever be a hint', async () => {
  const { cache } = mk();
  await learn(cache, ctx(), patch({ containsRedaction: true }));
  const d = await cache.find(ctx());
  assert.ok(d.kind === 'hit' && d.mode === 'hint_llm');
});

test('semantic tier: similar failure with a different fingerprint hits only above the thresholds', async () => {
  const strict = mk();
  await learn(strict.cache);
  const other = ctx({ fp: 'fp2', message: msg("Type 'boolean' is not assignable to type 'number'.") });
  const d0 = await strict.cache.find(other);
  assert.equal(d0.kind, 'miss');                                   // default thresholds: 0.92 / 0.97

  const lax = mk(loose);
  await learn(lax.cache);
  const d1 = await lax.cache.find(other);
  assert.ok(d1.kind === 'hit' && d1.tier === 'semantic' && d1.similarity < 1);
  const unrelated = await lax.cache.find(ctx({ fp: 'fp3', message: msg('Cannot find module react or its type declarations') }));
  assert.equal(unrelated.kind, 'miss');
});

test('structural gates: tool, code, language, toolchain must match exactly', async () => {
  const { cache } = mk(loose);
  await learn(cache);
  for (const o of [{ tool: 'eslint' }, { code: 'TS2345' }, { lang: 'js' }, { toolchain: 'tsc@4.9.5' }]) {
    const d = await cache.find(ctx({ fp: 'other', ...o }));
    assert.deepEqual(d, { kind: 'miss', reason: 'none' }, JSON.stringify(o));
  }
});

test('tenants are isolated: no reads, and no outcome reports against another tenant\'s rows', async () => {
  const { cache, store } = mk(loose);
  const entry = (await learn(cache))!;
  assert.deepEqual(await cache.find(ctx({ tenantId: 'tenant-b' })), { kind: 'miss', reason: 'none' });
  await cache.report('tenant-b', entry.id, false);
  await cache.report('tenant-b', entry.id, false);
  await cache.report('tenant-b', entry.id, false);
  const stored = store.entries.get(entry.id)!.entry;
  assert.equal(stored.failures, 0);
  assert.equal(stored.quarantined, false);
});

test('track record: successes never reduce eligibility; failures quarantine; relearning revives', async () => {
  const { cache, store } = mk();
  const e = (await learn(cache))!;
  for (let i = 0; i < 3; i++) {
    await cache.report('tenant-a', e.id, true);
    assert.equal((await cache.find(ctx())).kind, 'hit', `after ${i + 1} successes`);
  }
  // mixed record: evidence now says it is unreliable
  const flaky = mk();
  const f = (await learn(flaky.cache))!;
  await flaky.cache.report('tenant-a', f.id, true);
  await flaky.cache.report('tenant-a', f.id, false);
  await flaky.cache.report('tenant-a', f.id, false);
  assert.deepEqual(await flaky.cache.find(ctx()), { kind: 'miss', reason: 'low_confidence' });
  await flaky.cache.report('tenant-a', f.id, false);               // third failure, failures > successes
  assert.equal(flaky.store.entries.get(f.id)!.entry.quarantined, true);
  assert.deepEqual(await flaky.cache.find(ctx()), { kind: 'miss', reason: 'none' });
  const again = (await learn(flaky.cache, ctx(), patch({ files: ['y.ts'] })))!;
  assert.equal(again.id, f.id);
  assert.equal(flaky.store.entries.get(f.id)!.entry.quarantined, false);
  assert.deepEqual(flaky.store.entries.get(f.id)!.entry.patch.files, ['y.ts']);
  assert.equal((await flaky.cache.find(ctx())).kind, 'hit');
  void store;
});

test('wilsonLowerBound: evidence matters', () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(wilsonLowerBound(1, 0) < wilsonLowerBound(3, 0));
  assert.ok(wilsonLowerBound(3, 0) < wilsonLowerBound(20, 0));
  assert.ok(wilsonLowerBound(20, 0) < 1);
  assert.ok(wilsonLowerBound(1, 2) < 0.4);
});

test('learn() only stores verified, strictly-improving, reasonably small fixes', async () => {
  const { cache, store } = mk();
  assert.equal(await cache.learn({ ctx: ctx(), patch: patch(), resolved: false, before: [3, 0], after: [0, 0] }), null);
  assert.equal(await cache.learn({ ctx: ctx(), patch: patch(), resolved: true, before: [2, 1e9], after: [2, 1e9] }), null);
  assert.equal(await cache.learn({ ctx: ctx(), patch: patch(), resolved: true, before: [0, 1], after: [0, 3] }), null);
  assert.equal(await cache.learn({ ctx: ctx(), patch: patch({ diff: asScrubbed('x'.repeat(70_000)) }), resolved: true, before: [3, 0], after: [0, 0] }), null);
  assert.equal(store.entries.size, 0);
  assert.ok(await learn(cache));
  assert.equal(store.entries.size, 1);
  await learn(cache);                                              // idempotent: same fingerprint, no duplicate row
  assert.equal(store.entries.size, 1);
});

test('resolve(): one generation per failure in flight; verbatim hits skip the model entirely', async () => {
  const { cache } = mk();
  let calls = 0;
  const generate = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return patch(); };
  const results = await Promise.all(Array.from({ length: 10 }, () => cache.resolve(ctx(), generate)));
  assert.equal(calls, 1);
  assert.ok(results.every(r => r.source === 'llm' && r.patch === results[0]!.patch));

  await learn(cache);
  const hit = await cache.resolve(ctx(), generate);
  assert.equal(hit.source, 'cache');
  assert.equal(calls, 1);

  let hint: unknown = 'unset';
  const moved = await cache.resolve(ctx({ contextSha: 'ctx-9' }), async h => { hint = h; return patch(); });
  assert.equal(moved.source, 'llm');                               // region changed: ask the model, but with the cached fix as a hint
  assert.ok(hint !== null && hint !== 'unset');
});

test('embedding input is the normalized failure: paths, lines and redaction tags do not move the vector', () => {
  const a = buildKeyText(ctx({ message: msg("/home/a/src/x.ts:12:5 auth [REDACTED:github_token:aaaaaaaa] failed") }));
  const b = buildKeyText(ctx({ message: msg("/srv/w/src/x.ts:99:1 auth [REDACTED:github_token:bbbbbbbb] failed") }));
  assert.equal(a, b);
});

test('HashingEmbedder: unit norm, deterministic, similar > unrelated', async () => {
  const [x, y, z, x2] = await embedder.embed([
    msg("Type 'string' is not assignable to type 'number'."),
    msg("Type 'boolean' is not assignable to type 'number'."),
    msg('Cannot find module react or its corresponding type declarations'),
    msg("Type 'string' is not assignable to type 'number'."),
  ]);
  assert.ok(Math.abs(cosine(x!, x!) - 1) < 1e-5);
  assert.deepEqual(x, x2);
  assert.ok(cosine(x!, y!) > cosine(x!, z!) + 0.2);
});

test('unscrubbed text cannot be embedded (compile-time)', async () => {
  // @ts-expect-error a plain string is not Scrubbed; this line must fail typechecking
  const p = embedder.embed(['raw text that was never scrubbed']);
  await p;
});

test('pgvector DDL and literal', () => {
  const ddl = cacheDdl(256);
  assert.match(ddl, /vector\(256\)/);
  assert.match(ddl, /USING hnsw \(embedding vector_cosine_ops\)/);
  assert.match(ddl, /ENABLE ROW LEVEL SECURITY/);
  assert.match(ddl, /UNIQUE INDEX[^;]*\(tenant_id, fp, toolchain, embed_model\)/);
  assert.equal(vectorLiteral(new Float32Array([0.5, -1, 0])), '[0.5,-1,0]');
});
