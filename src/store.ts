import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

export class FencedOut extends Error {}
export class SeqConflict extends Error {}

export interface EventRow {
  tenantId: string; runId: string; branchId: number; seq: number; fence: number;
  from: string | null; to: string; artifact: unknown; promptSha?: Buffer; treeRoot?: Buffer;
}

export const DDL = `
CREATE TABLE IF NOT EXISTS run_events (
  tenant_id uuid NOT NULL, run_id uuid NOT NULL, branch_id smallint NOT NULL DEFAULT 0,
  seq bigint NOT NULL, fence bigint NOT NULL,
  from_state text, to_state text NOT NULL, artifact jsonb NOT NULL,
  prompt_sha bytea, tree_root bytea, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id, branch_id, seq)
) PARTITION BY HASH (tenant_id);
-- CREATE TABLE run_events_p0 PARTITION OF run_events FOR VALUES WITH (MODULUS 16, REMAINDER 0); ...x16
ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_iso ON run_events
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
-- REVOKE UPDATE, DELETE ON run_events FROM app_role;  (append-only)
`;

/** Postgres is the arbiter: PK rejects duplicate seq, fence guard rejects zombies. */
export class EventStore {
  constructor(private pool: Pool) {}

  async append(e: EventRow): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [e.tenantId]);
      const r = await c.query(
        `INSERT INTO run_events
           (tenant_id, run_id, branch_id, seq, fence, from_state, to_state, artifact, prompt_sha, tree_root)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
         WHERE NOT EXISTS (
           SELECT 1 FROM run_events
           WHERE tenant_id=$1 AND run_id=$2 AND branch_id=$3 AND fence > $5)`,
        [e.tenantId, e.runId, e.branchId, e.seq, e.fence, e.from, e.to,
         JSON.stringify(e.artifact), e.promptSha ?? null, e.treeRoot ?? null]);
      if (r.rowCount === 0) throw new FencedOut(`fence ${e.fence} superseded`);
      await c.query('COMMIT');
    } catch (err: any) {
      await c.query('ROLLBACK').catch(() => {});
      if (err?.code === '23505') throw new SeqConflict(`seq ${e.seq} already written`);
      throw err;
    } finally { c.release(); }
  }
}

const ACQUIRE = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return redis.call('INCR', KEYS[2])
end
return 0`;
const RENEW   = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) end return 0`;
const RELEASE = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`;
const CAS_PUT = `
local v = tonumber(redis.call('HGET', KEYS[1], 'v') or '0')
if tonumber(ARGV[1]) > v then redis.call('HSET', KEYS[1], 'v', ARGV[1], 'state', ARGV[2]) return 1 end
return 0`;

export interface Lease { key: string; token: string; fence: number }

/** Redis = liveness hint + fence source. Never trusted for safety on its own. */
export class LeaseManager {
  constructor(private r: Redis, private ttlMs = 15_000) {}
  private keys(t: string, run: string, b: number) {
    const tag = `t:{${t}}:run:{${run}}:b${b}`;   // same hash tag -> same cluster slot
    return { lease: `${tag}:lease`, fence: `${tag}:fence`, hot: `${tag}:hot` };
  }

  async acquire(t: string, run: string, b = 0): Promise<Lease | null> {
    const k = this.keys(t, run, b); const token = randomUUID();
    const fence = Number(await this.r.eval(ACQUIRE, 2, k.lease, k.fence, token, this.ttlMs));
    return fence > 0 ? { key: k.lease, token, fence } : null;
  }
  async renew(l: Lease): Promise<boolean> {
    return Number(await this.r.eval(RENEW, 1, l.key, l.token, this.ttlMs)) === 1;
  }
  async release(l: Lease): Promise<void> { await this.r.eval(RELEASE, 1, l.key, l.token); }
  async putHot(t: string, run: string, b: number, version: number, json: string): Promise<boolean> {
    return Number(await this.r.eval(CAS_PUT, 1, this.keys(t, run, b).hot, version, json)) === 1;
  }
}
