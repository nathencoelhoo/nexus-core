export type LedgerStatus = 'INTENT' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'COMPENSATED';

export interface LedgerRow {
  key: string;
  tenantId: string;
  runId: string;
  action: string;
  provider: string;
  status: LedgerStatus;
  attempt: number;
  leaseExpiresAt: number | null;
  result: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BeginInput { key: string; tenantId: string; runId: string; action: string; provider: string; leaseMs: number }

export type BeginResult =
  | { kind: 'started'; attempt: number }      // first ever attempt
  | { kind: 'resumed'; attempt: number }      // a prior attempt's outcome is unknown
  | { kind: 'already_succeeded'; result: unknown }
  | { kind: 'failed'; error: string }         // permanent
  | { kind: 'in_flight' };                    // another worker holds a live lease

/**
 * Write-ahead ledger. begin() is the ONLY gate in front of an external side effect, and it is atomic.
 * Every mutation after begin() is fenced by `attempt`, so a worker whose lease expired cannot overwrite
 * the record of the worker that took over.
 */
export interface LedgerStore {
  begin(i: BeginInput): Promise<BeginResult>;
  extendLease(key: string, attempt: number, leaseMs: number): Promise<boolean>;
  succeed(key: string, attempt: number, result: unknown): Promise<boolean>;
  fail(key: string, attempt: number, error: string): Promise<boolean>;
  /** Retryable: the outcome of this attempt is unknown. */
  markUnknown(key: string, attempt: number, error: string): Promise<boolean>;
  markCompensated(key: string): Promise<boolean>;
  get(key: string): Promise<LedgerRow | null>;
  /** INTENT rows with an expired lease, and UNKNOWN rows not touched for `olderThanMs`. */
  listStuck(olderThanMs: number): Promise<LedgerRow[]>;
}

/** Reference implementation with the same semantics as the SQL in pgLedger.ts. Used by unit tests. */
export class MemoryLedgerStore implements LedgerStore {
  rows = new Map<string, LedgerRow>();
  private now: () => number;

  constructor(now: () => number = Date.now) { this.now = now; }

  async begin(i: BeginInput): Promise<BeginResult> {
    const t = this.now();
    const r = this.rows.get(i.key);
    if (!r) {
      this.rows.set(i.key, {
        key: i.key, tenantId: i.tenantId, runId: i.runId, action: i.action, provider: i.provider,
        status: 'INTENT', attempt: 1, leaseExpiresAt: t + i.leaseMs, result: null, error: null, createdAt: t, updatedAt: t,
      });
      return { kind: 'started', attempt: 1 };
    }
    if (r.status === 'UNKNOWN' || (r.status === 'INTENT' && (r.leaseExpiresAt ?? 0) < t)) {
      r.status = 'INTENT'; r.attempt += 1; r.leaseExpiresAt = t + i.leaseMs; r.updatedAt = t;
      return { kind: 'resumed', attempt: r.attempt };
    }
    if (r.status === 'SUCCEEDED') return { kind: 'already_succeeded', result: r.result };
    if (r.status === 'FAILED' || r.status === 'COMPENSATED') return { kind: 'failed', error: r.error ?? r.status };
    return { kind: 'in_flight' };
  }

  private owned(key: string, attempt: number): LedgerRow | null {
    const r = this.rows.get(key);
    return r && r.status === 'INTENT' && r.attempt === attempt ? r : null;
  }

  async extendLease(key: string, attempt: number, leaseMs: number): Promise<boolean> {
    const r = this.owned(key, attempt); if (!r) return false;
    r.leaseExpiresAt = this.now() + leaseMs; return true;
  }
  async succeed(key: string, attempt: number, result: unknown): Promise<boolean> {
    const r = this.owned(key, attempt); if (!r) return false;
    r.status = 'SUCCEEDED'; r.result = result; r.leaseExpiresAt = null; r.updatedAt = this.now(); return true;
  }
  async fail(key: string, attempt: number, error: string): Promise<boolean> {
    const r = this.owned(key, attempt); if (!r) return false;
    r.status = 'FAILED'; r.error = error; r.leaseExpiresAt = null; r.updatedAt = this.now(); return true;
  }
  async markUnknown(key: string, attempt: number, error: string): Promise<boolean> {
    const r = this.owned(key, attempt); if (!r) return false;
    r.status = 'UNKNOWN'; r.error = error; r.leaseExpiresAt = null; r.updatedAt = this.now(); return true;
  }
  async markCompensated(key: string): Promise<boolean> {
    const r = this.rows.get(key); if (!r) return false;
    r.status = 'COMPENSATED'; r.updatedAt = this.now(); return true;
  }
  async get(key: string): Promise<LedgerRow | null> { return this.rows.get(key) ?? null; }
  async listStuck(olderThanMs: number): Promise<LedgerRow[]> {
    const t = this.now();
    return [...this.rows.values()].filter(r =>
      (r.status === 'INTENT' && (r.leaseExpiresAt ?? 0) < t) ||
      (r.status === 'UNKNOWN' && t - r.updatedAt >= olderThanMs));
  }
}
