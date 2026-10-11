import type { Pool } from 'pg';
import type { BeginInput, BeginResult, LedgerRow, LedgerStatus, LedgerStore } from './ledger.ts';

/**
 * No row-level security here, unlike run_events: the ledger is only touched by trusted workers
 * (never by tenant-scoped sessions) and the reconciler must scan across tenants. The key already
 * hashes the tenant id, so cross-tenant collisions are not a concern.
 */
export const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS action_ledger (
  key               text PRIMARY KEY,
  tenant_id         uuid        NOT NULL,
  run_id            uuid        NOT NULL,
  action            text        NOT NULL,
  provider          text        NOT NULL,
  status            text        NOT NULL CHECK (status IN ('INTENT','SUCCEEDED','FAILED','UNKNOWN','COMPENSATED')),
  attempt           integer     NOT NULL DEFAULT 1,
  lease_expires_at  timestamptz,
  result            jsonb,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_ledger_stuck ON action_ledger (status, lease_expires_at);
CREATE INDEX IF NOT EXISTS action_ledger_run ON action_ledger (run_id);
`;

interface Row {
  key: string; tenant_id: string; run_id: string; action: string; provider: string; status: LedgerStatus;
  attempt: number; lease_ms: string | null; result: unknown; error: string | null; created_ms: string; updated_ms: string;
}

const COLS = `key, tenant_id, run_id, action, provider, status, attempt,
  (extract(epoch from lease_expires_at) * 1000)::bigint AS lease_ms, result, error,
  (extract(epoch from created_at) * 1000)::bigint AS created_ms,
  (extract(epoch from updated_at) * 1000)::bigint AS updated_ms`;

const toRow = (r: Row): LedgerRow => ({
  key: r.key, tenantId: r.tenant_id, runId: r.run_id, action: r.action, provider: r.provider, status: r.status,
  attempt: r.attempt, leaseExpiresAt: r.lease_ms === null ? null : Number(r.lease_ms), result: r.result, error: r.error,
  createdAt: Number(r.created_ms), updatedAt: Number(r.updated_ms),
});

export class PgLedgerStore implements LedgerStore {
  private pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  /**
   * One atomic statement: insert a fresh INTENT, or take over a row whose lease expired / whose last attempt
   * is UNKNOWN. If neither applies the WHERE clause rejects the update and we read the row to explain why.
   * Time comes from the database clock (now()), so worker clock skew cannot shorten a lease.
   */
  async begin(i: BeginInput): Promise<BeginResult> {
    const up = await this.pool.query<{ attempt: number }>(
      `INSERT INTO action_ledger (key, tenant_id, run_id, action, provider, status, attempt, lease_expires_at)
       VALUES ($1, $2, $3, $4, $5, 'INTENT', 1, now() + ($6 * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE
         SET status = 'INTENT', attempt = action_ledger.attempt + 1,
             lease_expires_at = now() + ($6 * interval '1 millisecond'), updated_at = now()
         WHERE action_ledger.status = 'UNKNOWN'
            OR (action_ledger.status = 'INTENT' AND action_ledger.lease_expires_at < now())
       RETURNING attempt`,
      [i.key, i.tenantId, i.runId, i.action, i.provider, i.leaseMs]);
    const got = up.rows[0];
    if (got) return got.attempt === 1 ? { kind: 'started', attempt: 1 } : { kind: 'resumed', attempt: got.attempt };

    const cur = await this.get(i.key);
    if (!cur) throw new Error(`ledger row vanished for ${i.key}`);
    if (cur.status === 'SUCCEEDED') return { kind: 'already_succeeded', result: cur.result };
    if (cur.status === 'FAILED' || cur.status === 'COMPENSATED') return { kind: 'failed', error: cur.error ?? cur.status };
    return { kind: 'in_flight' };
  }

  private async fenced(sql: string, params: unknown[]): Promise<boolean> {
    const r = await this.pool.query(sql, params);
    return (r.rowCount ?? 0) === 1;
  }

  extendLease(key: string, attempt: number, leaseMs: number): Promise<boolean> {
    return this.fenced(
      `UPDATE action_ledger SET lease_expires_at = now() + ($3 * interval '1 millisecond')
       WHERE key = $1 AND attempt = $2 AND status = 'INTENT'`, [key, attempt, leaseMs]);
  }
  succeed(key: string, attempt: number, result: unknown): Promise<boolean> {
    return this.fenced(
      `UPDATE action_ledger SET status = 'SUCCEEDED', result = $3::jsonb, lease_expires_at = NULL, updated_at = now()
       WHERE key = $1 AND attempt = $2 AND status = 'INTENT'`, [key, attempt, JSON.stringify(result ?? null)]);
  }
  fail(key: string, attempt: number, error: string): Promise<boolean> {
    return this.fenced(
      `UPDATE action_ledger SET status = 'FAILED', error = $3, lease_expires_at = NULL, updated_at = now()
       WHERE key = $1 AND attempt = $2 AND status = 'INTENT'`, [key, attempt, error]);
  }
  markUnknown(key: string, attempt: number, error: string): Promise<boolean> {
    return this.fenced(
      `UPDATE action_ledger SET status = 'UNKNOWN', error = $3, lease_expires_at = NULL, updated_at = now()
       WHERE key = $1 AND attempt = $2 AND status = 'INTENT'`, [key, attempt, error]);
  }
  markCompensated(key: string): Promise<boolean> {
    return this.fenced(`UPDATE action_ledger SET status = 'COMPENSATED', updated_at = now() WHERE key = $1`, [key]);
  }

  async get(key: string): Promise<LedgerRow | null> {
    const r = await this.pool.query<Row>(`SELECT ${COLS} FROM action_ledger WHERE key = $1`, [key]);
    const row = r.rows[0];
    return row ? toRow(row) : null;
  }

  async listStuck(olderThanMs: number): Promise<LedgerRow[]> {
    const r = await this.pool.query<Row>(
      `SELECT ${COLS} FROM action_ledger
       WHERE (status = 'INTENT' AND lease_expires_at < now())
          OR (status = 'UNKNOWN' AND updated_at < now() - ($1 * interval '1 millisecond'))
       ORDER BY updated_at LIMIT 500`, [olderThanMs]);
    return r.rows.map(toRow);
  }
}
