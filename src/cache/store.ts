import type { Scrubbed } from '../compliance/scrubber.ts';
import { cosine } from './embedder.ts';

/** A verified fix. The diff is scrubbed: it may be embedded, stored and shown to a model. */
export interface FixPatch {
  diff: Scrubbed;
  files: string[];
  /** sha256 of the code region the patch was made against. Equal => the diff applies verbatim. */
  contextSha: string;
  /** True if scrubbing altered the diff. Context lines no longer match the file, so it can only serve as a hint. */
  containsRedaction: boolean;
}

/** Structural gates: a candidate must match ALL of these exactly before similarity is even considered. */
export interface CacheKey {
  tenantId: string;
  tool: string;
  code: string;
  lang: string;
  /** e.g. "tsc@5.6.3". A fix for one toolchain version is not assumed to hold for another. */
  toolchain: string;
  embedModel: string;
}

export interface CacheEntry {
  id: string;
  tenantId: string;
  fp: string;
  tool: string; code: string; lang: string; toolchain: string; embedModel: string;
  patch: FixPatch;
  successes: number;
  failures: number;
  quarantined: boolean;
  createdAt: number;
  lastHitAt: number | null;
}

export interface Candidate { entry: CacheEntry; similarity: number }

export interface FixCacheStore {
  getExact(key: CacheKey, fp: string): Promise<CacheEntry | null>;
  search(key: CacheKey, embedding: Float32Array, k: number): Promise<Candidate[]>;
  /** Insert. On conflict: keep the existing entry, unless it is quarantined, in which case it is replaced and its record reset. */
  upsert(key: CacheKey, fp: string, embedding: Float32Array, patch: FixPatch): Promise<CacheEntry>;
  recordOutcome(tenantId: string, id: string, ok: boolean): Promise<void>;
}

export interface CachePolicy {
  minSimilarity: number;          // floor for any semantic hit
  minSimilarityUntested: number;  // stricter floor for entries with no track record
  minWilson: number;              // lower confidence bound on success rate for entries with a record
  quarantineAfterFailures: number;
  maxCandidates: number;
  /** A lookup slower than this is a miss: the cache must never cost more than the model call it tries to avoid. */
  embedTimeoutMs: number;
}

export const DEFAULT_CACHE_POLICY: CachePolicy = {
  minSimilarity: 0.92, minSimilarityUntested: 0.97, minWilson: 0.4, quarantineAfterFailures: 3, maxCandidates: 5, embedTimeoutMs: 3_000,
};

/** Wilson score lower bound (z=1.645, ~95% one-sided): 1 success of 1 is NOT trusted like 20 of 20. */
export function wilsonLowerBound(successes: number, failures: number, z = 1.645): number {
  const n = successes + failures;
  if (n === 0) return 0;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return (centre - margin) / denom;
}

/** Same semantics as the SQL in pgStore.ts; the reference implementation for unit tests. Brute-force cosine. */
export class MemoryFixCacheStore implements FixCacheStore {
  entries = new Map<string, { entry: CacheEntry; emb: Float32Array }>();
  private seq = 0;
  private quarantineAfter: number;
  private now: () => number;

  constructor(quarantineAfter = DEFAULT_CACHE_POLICY.quarantineAfterFailures, now: () => number = Date.now) {
    this.quarantineAfter = quarantineAfter;
    this.now = now;
  }

  private gate(e: CacheEntry, k: CacheKey): boolean {
    return e.tenantId === k.tenantId && e.tool === k.tool && e.code === k.code && e.lang === k.lang &&
      e.toolchain === k.toolchain && e.embedModel === k.embedModel && !e.quarantined;
  }

  async getExact(key: CacheKey, fp: string): Promise<CacheEntry | null> {
    for (const { entry } of this.entries.values()) if (entry.fp === fp && this.gate(entry, key)) return { ...entry };
    return null;
  }

  async search(key: CacheKey, embedding: Float32Array, k: number): Promise<Candidate[]> {
    return [...this.entries.values()]
      .filter(({ entry }) => this.gate(entry, key))
      .map(({ entry, emb }) => ({ entry: { ...entry }, similarity: cosine(embedding, emb) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }

  async upsert(key: CacheKey, fp: string, embedding: Float32Array, patch: FixPatch): Promise<CacheEntry> {
    for (const rec of this.entries.values()) {
      const e = rec.entry;
      if (e.tenantId === key.tenantId && e.fp === fp && e.toolchain === key.toolchain && e.embedModel === key.embedModel) {
        if (e.quarantined) { e.patch = patch; rec.emb = embedding; e.successes = 0; e.failures = 0; e.quarantined = false; }
        return { ...e };
      }
    }
    const entry: CacheEntry = {
      id: String(++this.seq), tenantId: key.tenantId, fp, tool: key.tool, code: key.code, lang: key.lang,
      toolchain: key.toolchain, embedModel: key.embedModel, patch, successes: 0, failures: 0,
      quarantined: false, createdAt: this.now(), lastHitAt: null,
    };
    this.entries.set(entry.id, { entry, emb: embedding });
    return { ...entry };
  }

  async recordOutcome(tenantId: string, id: string, ok: boolean): Promise<void> {
    const rec = this.entries.get(id);
    if (!rec || rec.entry.tenantId !== tenantId) return;          // tenants cannot touch each other's rows
    const e = rec.entry;
    if (ok) e.successes++; else e.failures++;
    e.lastHitAt = this.now();
    if (!ok && e.failures >= this.quarantineAfter && e.failures > e.successes) e.quarantined = true;
  }
}
