import type { Pool, PoolClient } from 'pg';
import type { CacheEntry, CacheKey, Candidate, FixCacheStore, FixPatch } from './store.ts';

/** Dimension is fixed at DDL time and must equal Embedder.dim. Requires pgvector >= 0.8 for iterative index scans. */
export const cacheDdl = (dim: number): string => `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS fix_cache (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid        NOT NULL,
  fp           text        NOT NULL,
  tool         text        NOT NULL,
  code         text        NOT NULL,
  lang         text        NOT NULL,
  toolchain    text        NOT NULL,
  embed_model  text        NOT NULL,
  embedding    vector(${dim}) NOT NULL,
  patch        jsonb       NOT NULL,
  successes    integer     NOT NULL DEFAULT 0,
  failures     integer     NOT NULL DEFAULT 0,
  quarantined  boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_hit_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS fix_cache_uniq ON fix_cache (tenant_id, fp, toolchain, embed_model);
CREATE INDEX IF NOT EXISTS fix_cache_gate ON fix_cache (tenant_id, tool, code, lang, toolchain) WHERE NOT quarantined;
CREATE INDEX IF NOT EXISTS fix_cache_hnsw ON fix_cache USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
ALTER TABLE fix_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_iso ON fix_cache
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
`;

interface Row {
  id: string; tenant_id: string; fp: string; tool: string; code: string; lang: string; toolchain: string;
  embed_model: string; patch: FixPatch; successes: number; failures: number; quarantined: boolean;
  created_ms: string; hit_ms: string | null; similarity?: number;
}

const COLS = `id::text, tenant_id, fp, tool, code, lang, toolchain, embed_model, patch, successes, failures, quarantined,
  (extract(epoch from created_at) * 1000)::bigint AS created_ms,
  (extract(epoch from last_hit_at) * 1000)::bigint AS hit_ms`;

const toEntry = (r: Row): CacheEntry => ({
  id: r.id, tenantId: r.tenant_id, fp: r.fp, tool: r.tool, code: r.code, lang: r.lang, toolchain: r.toolchain,
  embedModel: r.embed_model, patch: r.patch, successes: r.successes, failures: r.failures, quarantined: r.quarantined,
  createdAt: Number(r.created_ms), lastHitAt: r.hit_ms === null ? null : Number(r.hit_ms),
});

/** pgvector text literal. Float32 -> decimal is lossless enough for cosine ranking. */
export const vectorLiteral = (v: Float32Array): string => `[${Array.from(v).join(',')}]`;

export class PgFixCacheStore implements FixCacheStore {
  private pool: Pool;
  private quarantineAfter: number;
  private iterativeScan: boolean;

  constructor(pool: Pool, quarantineAfter = 3, iterativeScan = true) {
    this.pool = pool;
    this.quarantineAfter = quarantineAfter;
    this.iterativeScan = iterativeScan;
  }

  /** Every operation runs in a transaction with the tenant bound, so row-level security is the backstop to the WHERE clauses. */
  private async tx<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>, ann = false): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      if (ann) {
        // Filtered HNSW can return fewer than k rows (the filter applies after the index scan). Iterative scan keeps going.
        await c.query('SET LOCAL hnsw.ef_search = 100');
        if (this.iterativeScan) await c.query('SET LOCAL hnsw.iterative_scan = relaxed_order');
      }
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally { c.release(); }
  }

  getExact(key: CacheKey, fp: string): Promise<CacheEntry | null> {
    return this.tx(key.tenantId, async c => {
      const r = await c.query<Row>(
        `SELECT ${COLS} FROM fix_cache
         WHERE tenant_id = $1 AND fp = $2 AND tool = $3 AND code = $4 AND lang = $5 AND toolchain = $6
           AND embed_model = $7 AND NOT quarantined`,
        [key.tenantId, fp, key.tool, key.code, key.lang, key.toolchain, key.embedModel]);
      return r.rows[0] ? toEntry(r.rows[0]) : null;
    });
  }

  search(key: CacheKey, embedding: Float32Array, k: number): Promise<Candidate[]> {
    return this.tx(key.tenantId, async c => {
      const r = await c.query<Row>(
        `SELECT ${COLS}, 1 - (embedding <=> $1::vector) AS similarity FROM fix_cache
         WHERE tenant_id = $2 AND tool = $3 AND code = $4 AND lang = $5 AND toolchain = $6
           AND embed_model = $7 AND NOT quarantined
         ORDER BY embedding <=> $1::vector LIMIT $8`,
        [vectorLiteral(embedding), key.tenantId, key.tool, key.code, key.lang, key.toolchain, key.embedModel, k]);
      return r.rows.map(row => ({ entry: toEntry(row), similarity: Number(row.similarity) }));
    }, true);
  }

  upsert(key: CacheKey, fp: string, embedding: Float32Array, patch: FixPatch): Promise<CacheEntry> {
    return this.tx(key.tenantId, async c => {
      const r = await c.query<Row>(
        `INSERT INTO fix_cache (tenant_id, fp, tool, code, lang, toolchain, embed_model, embedding, patch)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9::jsonb)
         ON CONFLICT (tenant_id, fp, toolchain, embed_model) DO UPDATE SET
           patch       = CASE WHEN fix_cache.quarantined THEN EXCLUDED.patch ELSE fix_cache.patch END,
           embedding   = CASE WHEN fix_cache.quarantined THEN EXCLUDED.embedding ELSE fix_cache.embedding END,
           successes   = CASE WHEN fix_cache.quarantined THEN 0 ELSE fix_cache.successes END,
           failures    = CASE WHEN fix_cache.quarantined THEN 0 ELSE fix_cache.failures END,
           quarantined = false
         RETURNING ${COLS}`,
        [key.tenantId, fp, key.tool, key.code, key.lang, key.toolchain, key.embedModel, vectorLiteral(embedding), JSON.stringify(patch)]);
      return toEntry(r.rows[0]!);
    });
  }

  async recordOutcome(tenantId: string, id: string, ok: boolean): Promise<void> {
    await this.tx(tenantId, async c => {
      await c.query(
        ok
          ? `UPDATE fix_cache SET successes = successes + 1, last_hit_at = now() WHERE id = $1::bigint AND tenant_id = $2`
          : `UPDATE fix_cache SET failures = failures + 1, last_hit_at = now(),
               quarantined = (failures + 1 >= $3 AND failures + 1 > successes)
             WHERE id = $1::bigint AND tenant_id = $2`,
        ok ? [id, tenantId] : [id, tenantId, this.quarantineAfter]);
    });
  }
}
