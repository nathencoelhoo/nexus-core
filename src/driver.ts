import { transition } from './reducer.ts';
import { EventStore, LeaseManager, type Lease } from './store.ts';
import type { Artifact, Config, RunState, TransitionResult, Usage } from './types.ts';

export interface RunCtx { tenantId: string; runId: string; branchId: number }

/**
 * Write path: (1) reducer, (2) sync INSERT to Postgres (source of truth),
 * (3) best-effort Redis CAS, (4) caller dispatches next action.
 * Step 3 failing is harmless: readers fall back to Postgres.
 */
export async function advance(
  deps: { store: EventStore; leases: LeaseManager },
  ctx: RunCtx, lease: Lease, cur: RunState, artifact: Artifact,
  usage: Usage, cfg: Config, promptSha?: Buffer,
): Promise<TransitionResult> {
  const res = transition(cur, artifact, usage, cfg);
  await deps.store.append({
    ...ctx, seq: res.next.seq, fence: lease.fence, from: cur.state, to: res.next.state,
    artifact, promptSha, treeRoot: Buffer.from(res.next.treeRoot, 'hex'),
  });
  await deps.leases
    .putHot(ctx.tenantId, ctx.runId, ctx.branchId, res.next.seq, JSON.stringify(res.next))
    .catch(() => false);
  return res;
}
