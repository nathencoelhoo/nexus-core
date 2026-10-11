import { idempotencyKey } from './idempotency.ts';
import { classifyError, InFlightError, LeaseLost, PermanentFailure, RetryableFailure } from './errors.ts';
import type { LedgerStore } from './ledger.ts';

export interface ActionContext {
  /** Pass this to the provider as its idempotency token (AWS ClientToken, Stripe Idempotency-Key, ...). */
  token: string;
  attempt: number;
  /** Aborts on per-attempt timeout OR if this worker loses its lease. Wire it into every network call. */
  signal: AbortSignal;
}

export interface ExternalAction<P = unknown, R = unknown> {
  name: string;
  provider: string;
  /** True only if the provider dedupes on `token`. Otherwise `lookup` is mandatory. */
  nativeIdempotency: boolean;
  execute(params: P, ctx: ActionContext): Promise<R>;
  /** Find the resource created under `token` (tag/name lookup). Resolves ambiguous outcomes. */
  lookup?(token: string, signal: AbortSignal): Promise<R | null>;
  /** Delete a resource (used by the orphan reconciler). */
  compensate?(resource: R, signal: AbortSignal): Promise<void>;
  /** Enumerate provider-side resources carrying our tokens (for orphan detection). */
  inventory?(signal: AbortSignal): AsyncIterable<{ token: string; resource: R }>;
}

export function assertAction(a: ExternalAction<any, any>): void {
  if (!a.nativeIdempotency && !a.lookup) {
    throw new Error(`action "${a.name}": a provider without native idempotency must implement lookup()`);
  }
}

export interface RunnerDeps {
  ledger: LedgerStore;
  leaseMs?: number;
  attemptTimeoutMs?: number;
  onEvent?: (e: { type: 'dedupe' | 'resume' | 'lookup_hit' | 'lease_lost' | 'ledger_write_failed'; key: string }) => void;
}

export interface RunIdent { tenantId: string; runId: string; stepId: string }
export interface RunOutcome<R> { result: R; deduped: boolean; key: string }

/**
 * Exactly-once *effect* on top of at-least-once delivery:
 *   1. begin(): atomic write-ahead claim in Postgres (INTENT + lease)
 *   2. if a previous attempt's outcome is unknown: lookup() before doing anything
 *   3. execute() with the key as the provider token
 *   4. record the result, fenced by attempt
 * A crash between 3 and 4 leaves INTENT/UNKNOWN; the next attempt resolves it via lookup or the token.
 */
export async function runIdempotent<P, R>(
  action: ExternalAction<P, R>, params: P, id: RunIdent, deps: RunnerDeps,
): Promise<RunOutcome<R>> {
  const leaseMs = deps.leaseMs ?? 30_000;
  const timeoutMs = deps.attemptTimeoutMs ?? 20_000;
  const key = idempotencyKey({ ...id, action: action.name, params });
  const emit = (type: 'dedupe' | 'resume' | 'lookup_hit' | 'lease_lost' | 'ledger_write_failed') => deps.onEvent?.({ type, key });

  const b = await deps.ledger.begin({
    key, tenantId: id.tenantId, runId: id.runId, action: action.name, provider: action.provider, leaseMs,
  });
  if (b.kind === 'already_succeeded') { emit('dedupe'); return { result: b.result as R, deduped: true, key }; }
  if (b.kind === 'failed') throw new PermanentFailure(`previously failed permanently: ${b.error}`);
  if (b.kind === 'in_flight') throw new InFlightError();

  const attempt = b.attempt;
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(new DOMException('attempt timed out', 'TimeoutError')), timeoutMs);
  const heartbeat = setInterval(() => {
    deps.ledger.extendLease(key, attempt, leaseMs).then(
      ok => { if (!ok) { emit('lease_lost'); ac.abort(new LeaseLost('lease lost')); } },
      () => undefined,                       // a DB blip is not proof we lost the lease
    );
  }, Math.max(5, Math.floor(leaseMs / 3)));

  const record = async (result: R): Promise<R> => {
    let ok: boolean;
    try {
      ok = await deps.ledger.succeed(key, attempt, result);
    } catch (e) {
      // The side effect HAS happened but we could not record it. Never mark FAILED; make the next attempt resolve it.
      emit('ledger_write_failed');
      await deps.ledger.markUnknown(key, attempt, 'ledger write failed after success').catch(() => undefined);
      throw new RetryableFailure(`ledger write failed after external success: ${(e as Error).message}`, 'ambiguous');
    }
    if (ok) return result;
    const cur = await deps.ledger.get(key);          // someone newer owns it: trust what they recorded
    if (cur?.status === 'SUCCEEDED') return cur.result as R;
    throw new RetryableFailure('ledger ownership lost', 'transient');
  };

  try {
    if (b.kind === 'resumed') {
      emit('resume');
      if (action.lookup) {
        const found = await action.lookup(key, ac.signal);
        if (found !== null) { emit('lookup_hit'); return { result: await record(found), deduped: true, key }; }
      }
    }

    let result: R;
    try {
      result = await action.execute(params, { token: key, attempt, signal: ac.signal });
    } catch (e) {
      const c = classifyError(e);
      const msg = e instanceof Error ? e.message : String(e);
      if (c.cls === 'permanent') {
        await deps.ledger.fail(key, attempt, msg).catch(() => undefined);
        throw new PermanentFailure(msg, 'permanent');
      }
      // auth is job-permanent (retrying burns attempts) but ledger-retryable: a redrive after the fix must work.
      await deps.ledger.markUnknown(key, attempt, msg).catch(() => undefined);
      if (c.cls === 'auth') throw new PermanentFailure(msg, 'auth');
      throw new RetryableFailure(msg, c.cls, c.retryAfterMs);
    }
    return { result: await record(result), deduped: false, key };
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }
}
