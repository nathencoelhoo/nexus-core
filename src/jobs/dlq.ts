import { delayMs } from './backoff.ts';
import type { BackoffOpts } from './backoff.ts';
import type { ErrorClass } from './errors.ts';

export interface DeadLetter {
  key: string;
  jobType: 'action' | 'agent';
  tenantId: string;
  runId: string;
  action: string;
  provider: string;
  errorClass: ErrorClass | 'budget' | 'unknown';
  attempts: number;
  redrives: number;
  lastError: string;
  firstFailedAt: number;
}

export type Decision =
  | { kind: 'redrive'; delayMs: number; reconcileFirst: boolean }
  | { kind: 'quarantine'; reason: string }
  | { kind: 'escalate'; reason: string; pageHuman: boolean };

export interface TriageCtx {
  breakerRetryInMs(provider: string): number;      // 0 when the breaker is closed
  maxRedrives: number;
  backoff: BackoffOpts;
}

/**
 * Pure decision table. Order matters: budget and poison checks come before anything that retries.
 * A DLQ that blindly redrives turns one bad job into a retry storm; one that never redrives turns every outage into manual work.
 */
export function triage(d: DeadLetter, c: TriageCtx): Decision {
  if (d.redrives >= c.maxRedrives) return { kind: 'escalate', reason: `redrive budget exhausted (${d.redrives})`, pageHuman: false };
  if (d.errorClass === 'budget') return { kind: 'escalate', reason: 'run budget exhausted', pageHuman: false };
  if (d.errorClass === 'permanent') return { kind: 'quarantine', reason: 'permanent failure; redrive cannot help' };
  if (d.errorClass === 'auth') return { kind: 'escalate', reason: 'credentials or permissions rejected', pageHuman: true };

  // Exponential in the number of redrives so repeated outages back off at the DLQ level too.
  const base = delayMs(d.redrives + 1, c.backoff);
  const breakerWait = c.breakerRetryInMs(d.provider);
  const wait = Math.max(base, breakerWait);

  // Ambiguous = the resource may exist. Resolve that BEFORE redriving, or we risk paying for it twice.
  if (d.errorClass === 'ambiguous') return { kind: 'redrive', delayMs: wait, reconcileFirst: true };
  if (d.errorClass === 'throttled' || d.errorClass === 'transient') return { kind: 'redrive', delayMs: wait, reconcileFirst: false };
  return { kind: 'escalate', reason: `unclassified failure: ${d.lastError.slice(0, 120)}`, pageHuman: false };
}
