import { sha256 } from './fingerprint.ts';

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

/** Head+tail truncation with an explicit, retrievable elision marker. */
export function truncateHeadTail(text: string, maxTokens: number, blobRef: string): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const lines = text.split('\n');
  const keepChars = Math.max(maxTokens * 4 - 80, 0);
  const headBudget = Math.floor(keepChars * 0.4);
  const tailBudget = keepChars - headBudget;
  const head: string[] = []; let h = 0;
  for (const l of lines) { if (h + l.length + 1 > headBudget) break; head.push(l); h += l.length + 1; }
  const tail: string[] = []; let t = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const l = lines[i]!; if (t + l.length + 1 > tailBudget) break; tail.unshift(l); t += l.length + 1;
  }
  const elided = lines.length - head.length - tail.length;
  return [...head, `[… ${elided} lines elided, ref=${blobRef} …]`, ...tail].join('\n');
}

/** Drop framework frames, collapse consecutive repeats into ×N, keep top-k user frames. */
export function reduceStack(frames: string[], keep = 5): string[] {
  const user = frames.filter(f => !/node_modules|node:internal|<anonymous>/.test(f));
  const out: string[] = [];
  for (let i = 0; i < user.length;) {
    let j = i; while (j < user.length && user[j] === user[i]) j++;
    out.push(j - i > 1 ? `${user[i]} ×${j - i}` : user[i]!);
    i = j;
  }
  return out.slice(0, keep);
}

/** Template-built (not LLM-summarized): replayable, never drops negative knowledge. */
export interface LedgerEntry {
  n: number; fp: string; hypothesis: string;
  outcome: 'improved' | 'regressed' | 'no_change' | 'failed_to_apply';
  deltaScore: number;
}

export function renderLedger(entries: LedgerEntry[], budgetTokens: number): string {
  const lines: string[] = []; let used = 0;
  for (const e of [...entries].reverse()) {                    // newest first
    const l = `#${e.n} fp=${e.fp.slice(0, 8)} [${e.outcome}] Δ=${e.deltaScore} :: ${e.hypothesis}`;
    const cost = estimateTokens(l) + 1;
    if (used + cost > budgetTokens) {
      lines.push(`[… ${entries.length - lines.length} older attempts evicted; ids retained in audit log …]`);
      break;
    }
    lines.push(l); used += cost;
  }
  return lines.reverse().join('\n');
}

export interface Tiers { pinned: string; working: string; failure: string; ledger: string }
const SPLIT = { pinned: 0.15, working: 0.45, failure: 0.25, ledger: 0.15 } as const;

export function assemblePrompt(t: Tiers, totalTokens: number, blobRefs: Record<keyof Tiers, string>) {
  const part = (k: keyof Tiers) =>
    `## ${k.toUpperCase()}\n` +
    (k === 'ledger' ? t.ledger : truncateHeadTail(t[k], Math.floor(totalTokens * SPLIT[k]), blobRefs[k]));
  const prompt = (['pinned', 'working', 'failure', 'ledger'] as const).map(part).join('\n\n');
  return { prompt, promptSha: sha256(prompt), tokens: estimateTokens(prompt) };
}
