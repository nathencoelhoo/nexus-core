import type { ExternalAction } from './runner.ts';
import type { LedgerStore } from './ledger.ts';

export interface ReconcileDeps {
  ledger: LedgerStore;
  actions: Map<string, ExternalAction<any, any>>;
  stuckMs: number;
  /** True when the run reached a terminal state that does not retain its infrastructure. */
  isRunDead(runId: string): Promise<boolean>;
  /** Blast-radius limit: a buggy predicate must not be able to delete the world. */
  maxReaps?: number;
  signal?: AbortSignal;
}

export interface ReconcileReport {
  adopted: string[];
  stillUnknown: string[];
  orphansDeleted: string[];
  capped: boolean;
  errors: string[];
}

/**
 * Two sweeps that close the two ways money leaks:
 *  A. ledger -> provider: attempts that crashed mid-flight. If the resource exists, adopt it as SUCCEEDED.
 *  B. provider -> ledger: resources that exist but should not (no row, FAILED, COMPENSATED, or run is dead). Delete them.
 * Because begin() writes INTENT *before* the provider call, every real resource has a ledger row, so
 * "no row" can only mean it is not ours to keep.
 */
export async function reconcile(d: ReconcileDeps): Promise<ReconcileReport> {
  const signal = d.signal ?? new AbortController().signal;
  const maxReaps = d.maxReaps ?? 20;
  const report: ReconcileReport = { adopted: [], stillUnknown: [], orphansDeleted: [], capped: false, errors: [] };

  for (const row of await d.ledger.listStuck(d.stuckMs)) {
    const action = d.actions.get(row.action);
    if (!action?.lookup) { report.stillUnknown.push(row.key); continue; }
    try {
      const found = await action.lookup(row.key, signal);
      if (found !== null) {
        // Fenced by the attempt we observed: if a live worker took over meanwhile, this is a harmless no-op.
        const ok = await d.ledger.succeed(row.key, row.attempt, found);
        (ok ? report.adopted : report.stillUnknown).push(row.key);
      } else report.stillUnknown.push(row.key);
    } catch (e) { report.errors.push(`lookup ${row.key}: ${(e as Error).message}`); }
  }

  for (const action of d.actions.values()) {
    if (!action.inventory || !action.compensate) continue;
    try {
      for await (const { token, resource } of action.inventory(signal)) {
        const row = await d.ledger.get(token);
        const orphan =
          row === null || row.status === 'FAILED' || row.status === 'COMPENSATED' ||
          (row.status === 'SUCCEEDED' && await d.isRunDead(row.runId));
        if (!orphan) continue;
        if (report.orphansDeleted.length >= maxReaps) { report.capped = true; break; }
        await action.compensate(resource, signal);
        if (row) await d.ledger.markCompensated(token);
        report.orphansDeleted.push(token);
      }
    } catch (e) { report.errors.push(`inventory ${action.name}: ${(e as Error).message}`); }
  }
  return report;
}
