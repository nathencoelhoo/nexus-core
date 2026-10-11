export interface BackoffOpts {
  baseMs: number;
  capMs: number;
  /** Upper bound on how long we will honor a provider's Retry-After. */
  maxRetryAfterMs?: number;
  rng?: () => number;
}

/** Full jitter: uniform in [0, min(cap, base * 2^(attempt-1))). Minimizes synchronized retry herds. */
export function backoffMs(attempt: number, o: BackoffOpts): number {
  const exp = Math.min(o.capMs, o.baseMs * 2 ** Math.min(Math.max(attempt - 1, 0), 30));
  return Math.floor((o.rng ?? Math.random)() * exp);
}

/** Never retry earlier than the provider asked, but don't let a hostile header park a job forever. */
export function delayMs(attempt: number, o: BackoffOpts, retryAfterMs?: number): number {
  const jittered = backoffMs(attempt, o);
  if (retryAfterMs === undefined) return jittered;
  const floor = Math.min(retryAfterMs, o.maxRetryAfterMs ?? 5 * 60_000);
  return Math.max(jittered, floor) + Math.floor((o.rng ?? Math.random)() * o.baseMs);
}
