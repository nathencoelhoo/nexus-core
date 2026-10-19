import { asScrubbed } from '../compliance/scrubber.ts';
import type { Embedder } from './embedder.ts';
import { cosine } from './embedder.ts';

/** `group` is the exact-match gate (tool + error code); `cluster` is the fix class the cache must tell apart WITHIN a group. */
export interface LabeledText { group: string; cluster: string; text: string }

export interface RetrievalReport {
  items: number;
  /** For each text: is its nearest neighbour (within the group) from the same cluster? */
  recallAt1: number;
  /** Mean reciprocal rank of the first same-cluster neighbour. */
  mrr: number;
  sameMean: number;
  diffMean: number;
  /** sameMean - diffMean: how far apart "same fix" and "different fix" sit. Cache thresholds live in this gap. */
  margin: number;
  perGroup: Record<string, { recallAt1: number; mrr: number; items: number }>;
}

export async function evaluateRetrieval(embedder: Embedder, data: LabeledText[]): Promise<RetrievalReport> {
  const vecs = await embedder.embed(data.map(d => asScrubbed(d.text)));
  let hits = 0, rr = 0, n = 0, sameSum = 0, sameN = 0, diffSum = 0, diffN = 0;
  const per: Record<string, { hits: number; rr: number; n: number }> = {};
  for (let i = 0; i < data.length; i++) {
    const a = data[i]!;
    const ranked: Array<{ same: boolean; sim: number }> = [];
    for (let j = 0; j < data.length; j++) {
      const b = data[j]!;
      if (i === j || b.group !== a.group) continue;
      const sim = cosine(vecs[i]!, vecs[j]!);
      const same = b.cluster === a.cluster;
      ranked.push({ same, sim });
      if (j > i) { if (same) { sameSum += sim; sameN++; } else { diffSum += sim; diffN++; } }
    }
    ranked.sort((x, y) => y.sim - x.sim);
    const first = ranked.findIndex(r => r.same);
    const g = (per[a.group] ??= { hits: 0, rr: 0, n: 0 });
    g.n++; n++;
    if (first === 0) { hits++; g.hits++; }
    if (first >= 0) { rr += 1 / (first + 1); g.rr += 1 / (first + 1); }
  }
  const sameMean = sameN ? sameSum / sameN : 0, diffMean = diffN ? diffSum / diffN : 0;
  return {
    items: n, recallAt1: hits / n, mrr: rr / n, sameMean, diffMean, margin: sameMean - diffMean,
    perGroup: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, { recallAt1: v.hits / v.n, mrr: v.rr / v.n, items: v.n }])),
  };
}

export interface SweepRow { threshold: number; precision: number; recall: number; hits: number }

/**
 * For every ordered pair within a group, "the cache would serve a fix" when cosine >= threshold. A served fix is correct
 * only if both texts are in the same cluster. Precision matters most (a wrong cached patch wastes a compile-test cycle and
 * counts against the loop budget); recall is the LLM calls saved.
 */
export async function thresholdSweep(embedder: Embedder, data: LabeledText[], thresholds: number[]): Promise<SweepRow[]> {
  const vecs = await embedder.embed(data.map(d => asScrubbed(d.text)));
  const pairs: Array<{ sim: number; same: boolean }> = [];
  for (let i = 0; i < data.length; i++) for (let j = i + 1; j < data.length; j++) {
    if (data[i]!.group !== data[j]!.group) continue;
    pairs.push({ sim: cosine(vecs[i]!, vecs[j]!), same: data[i]!.cluster === data[j]!.cluster });
  }
  const positives = pairs.filter(p => p.same).length;
  return thresholds.map(threshold => {
    const served = pairs.filter(p => p.sim >= threshold);
    const correct = served.filter(p => p.same).length;
    return { threshold, hits: served.length, precision: served.length ? correct / served.length : 1, recall: positives ? correct / positives : 0 };
  });
}

/** The highest-recall threshold whose precision is at least `minPrecision`, or null if none exists. */
export function bestThreshold(rows: SweepRow[], minPrecision: number): SweepRow | null {
  const ok = rows.filter(r => r.precision >= minPrecision && r.hits > 0);
  return ok.length ? ok.reduce((a, b) => (b.recall > a.recall ? b : a)) : null;
}
