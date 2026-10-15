import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { ENABLED, adminPool, appPool, itest, uuid } from './_helpers.ts';
import { cacheDdl, PgFixCacheStore } from '../../src/cache/pgStore.ts';
import { MemoryFixCacheStore } from '../../src/cache/store.ts';
import type { CacheKey, FixPatch } from '../../src/cache/store.ts';
import { HashingEmbedder } from '../../src/cache/embedder.ts';
import { asScrubbed } from '../../src/compliance/scrubber.ts';

const DIM = 32;
const embedder = new HashingEmbedder(DIM);
let admin: Pool; let app: Pool; let pgs: PgFixCacheStore;

if (ENABLED) {
  before(async () => {
    admin = adminPool();
    await admin.query('DROP TABLE IF EXISTS fix_cache CASCADE');
    await admin.query(cacheDdl(DIM));
    app = await appPool(admin);
    await admin.query('GRANT SELECT, INSERT, UPDATE ON fix_cache TO nexus_app');
    await admin.query('GRANT USAGE, SELECT ON SEQUENCE fix_cache_id_seq TO nexus_app');
    pgs = new PgFixCacheStore(app, 3, true);
  });
  after(async () => { await app?.end(); await admin?.end(); });
}

const key = (tenantId: string): CacheKey => ({ tenantId, tool: 'tsc', code: 'TS2322', lang: 'ts', toolchain: 'tsc@5.6.3', embedModel: embedder.model });
const patch = (n = 0): FixPatch => ({ diff: asScrubbed(`diff ${n}`), files: ['x.ts'], contextSha: `c${n}`, containsRedaction: false });
const vec = async (text: string) => (await embedder.embed([asScrubbed(text)]))[0]!;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
function randomUnit(r: () => number): Float32Array {
  const v = new Float32Array(DIM);
  let n = 0;
  for (let i = 0; i < DIM; i++) { v[i] = r() * 2 - 1; n += v[i]! * v[i]!; }
  n = Math.sqrt(n);
  for (let i = 0; i < DIM; i++) v[i]! /= n;
  return v;
}

itest('DDL applied: vector column, unique index, HNSW index, RLS enabled', async () => {
  const idx = await admin.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'fix_cache'`);
  assert.ok(idx.rows.some(r => r.indexname === 'fix_cache_hnsw' && /hnsw/.test(r.indexdef)));
  assert.ok(idx.rows.some(r => r.indexname === 'fix_cache_uniq'));
  const rls = await admin.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'fix_cache'`);
  assert.equal(rls.rows[0].relrowsecurity, true);
});

itest('search matches the in-memory reference: same entries, same order, same similarity', async () => {
  const a = uuid(), b = uuid();
  const mem = new MemoryFixCacheStore(3);
  const messages = Array.from({ length: 40 }, (_, i) => `Type 'T${i}' is not assignable to type 'U${i % 7}' in module m${i % 5} line item${i * 13}`);
  for (const [i, m] of messages.entries()) {
    const v = await vec(m);
    for (const t of [a, b]) {
      await pgs.upsert(key(t), `fp-${i}`, v, patch(i));
      await mem.upsert(key(t), `fp-${i}`, v, patch(i));
    }
  }
  for (const q of ['Type string is not assignable to type U3 in module m2', 'Property foo does not exist on type Bar', 'T12 U5 m2 item156']) {
    const qv = await vec(q);
    const [p, m] = [await pgs.search(key(a), qv, 5), await mem.search(key(a), qv, 5)];
    assert.equal(p.length, 5);
    assert.deepEqual(p.map(c => c.entry.fp), m.map(c => c.entry.fp), q);
    p.forEach((c, i) => assert.ok(Math.abs(c.similarity - m[i]!.similarity) < 1e-4, `${q} #${i}: ${c.similarity} vs ${m[i]!.similarity}`));
  }
  const exact = await pgs.getExact(key(a), 'fp-7');
  assert.equal(exact?.patch.contextSha, 'c7');
  assert.equal(await pgs.getExact(key(a), 'nope'), null);
});

itest('structural gates are exact-match in SQL', async () => {
  const t = uuid();
  const v = await vec('gate test message');
  await pgs.upsert(key(t), 'g1', v, patch());
  for (const o of [{ tool: 'eslint' }, { code: 'TS1' }, { lang: 'js' }, { toolchain: 'tsc@4.9' }, { embedModel: 'other' }]) {
    assert.deepEqual(await pgs.search({ ...key(t), ...o }, v, 5), [], JSON.stringify(o));
    assert.equal(await pgs.getExact({ ...key(t), ...o }, 'g1'), null);
  }
  assert.equal((await pgs.search(key(t), v, 5)).length, 1);
});

itest('RLS: a tenant cannot see or write another tenant\'s rows, even with raw SQL', async () => {
  const a = uuid(), b = uuid();
  await pgs.upsert(key(a), 'rls-1', await vec('rls message one'), patch());
  await pgs.upsert(key(b), 'rls-2', await vec('rls message two'), patch());
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [b]);
    const seen = await c.query('SELECT tenant_id FROM fix_cache WHERE fp IN ($1, $2)', ['rls-1', 'rls-2']);
    assert.deepEqual(seen.rows.map(r => r.tenant_id), [b]);
    await assert.rejects(
      c.query(`INSERT INTO fix_cache (tenant_id, fp, tool, code, lang, toolchain, embed_model, embedding, patch)
               VALUES ($1, 'evil', 't', 'c', 'l', 'tc', 'm', $2::vector, '{}')`, [a, `[${new Array(DIM).fill(0.1).join(',')}]`]),
      (e: { code?: string }) => e.code === '42501');
    await c.query('ROLLBACK');
  } finally { c.release(); }
  // cross-tenant outcome reports are no-ops
  const entry = (await pgs.getExact(key(a), 'rls-1'))!;
  for (let i = 0; i < 3; i++) await pgs.recordOutcome(b, entry.id, false);
  const after = (await pgs.getExact(key(a), 'rls-1'))!;
  assert.equal(after.failures, 0);
  assert.equal(after.quarantined, false);
});

itest('RLS fails closed when no tenant is bound', async () => {
  await pgs.upsert(key(uuid()), 'unbound-1', await vec('unbound tenant message'), patch());
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    assert.equal((await c.query('SELECT 1 FROM fix_cache')).rowCount, 0);
    await c.query('ROLLBACK');
  } finally { c.release(); }
});

itest('outcome tracking, quarantine and revival match the in-memory reference', async () => {
  const t = uuid();
  const mem = new MemoryFixCacheStore(3);
  const v = await vec('quarantine model message');
  const p1 = await pgs.upsert(key(t), 'q1', v, patch(1));
  const m1 = await mem.upsert(key(t), 'q1', v, patch(1));
  const state = async () => {
    const [p, m] = [await pgs.getExact(key(t), 'q1'), await mem.getExact(key(t), 'q1')];
    const pr = (e: typeof p) => e && ({ s: e.successes, f: e.failures, q: e.quarantined, d: e.patch.diff });
    assert.deepEqual(pr(p), pr(m));
    return p;
  };
  assert.ok(await state());
  for (const ok of [true, false, false]) {                  // 1 success, 2 failures: not yet quarantined
    await pgs.recordOutcome(t, p1.id, ok); await mem.recordOutcome(t, m1.id, ok);
    assert.ok(await state());
  }
  await pgs.recordOutcome(t, p1.id, false); await mem.recordOutcome(t, m1.id, false);   // 3rd failure, failures > successes
  assert.equal(await state(), null);                         // quarantined: invisible to getExact and search
  assert.deepEqual(await pgs.search(key(t), v, 5), []);
  const re1 = await pgs.upsert(key(t), 'q1', v, patch(2));   // relearn: replaces the patch and resets the record
  const re2 = await mem.upsert(key(t), 'q1', v, patch(2));
  assert.equal(re1.id, p1.id);
  assert.equal(re1.quarantined, false);
  assert.equal(re2.quarantined, false);
  const revived = await state();
  assert.deepEqual([revived?.successes, revived?.failures, revived?.patch.diff], [0, 0, 'diff 2']);
  const again = await pgs.upsert(key(t), 'q1', v, patch(3));  // non-quarantined conflict keeps the existing entry
  assert.equal(again.patch.diff, 'diff 2');
});

itest('filtered ANN: always returns k rows for the tenant, with high recall, in a table dominated by another tenant', async () => {
  const r = rng(42);
  const a = uuid(), b = uuid();
  const mem = new MemoryFixCacheStore(3);
  for (let i = 0; i < 120; i++) { const v = randomUnit(r); await pgs.upsert(key(a), `A-${i}`, v, patch(i)); await mem.upsert(key(a), `A-${i}`, v, patch(i)); }
  const noise: Array<Promise<unknown>> = [];
  for (let i = 0; i < 1500; i++) {
    noise.push(pgs.upsert(key(b), `B-${i}`, randomUnit(r), patch(i)));
    if (noise.length === 20) await Promise.all(noise.splice(0));
  }
  await Promise.all(noise);
  let hits = 0, total = 0;
  for (let q = 0; q < 20; q++) {
    const qv = randomUnit(r);
    const got = await pgs.search(key(a), qv, 10);
    const want = await mem.search(key(a), qv, 10);
    assert.equal(got.length, 10, `query ${q} returned ${got.length} rows`);
    assert.ok(got.every(c => c.entry.tenantId === a));
    const wantFps = new Set(want.map(c => c.entry.fp));
    hits += got.filter(c => wantFps.has(c.entry.fp)).length; total += 10;
  }
  assert.ok(hits / total >= 0.9, `recall ${(hits / total).toFixed(3)}`);
});
