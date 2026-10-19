import { normalizeMessage } from '../fingerprint.ts';
import { asScrubbed } from '../compliance/scrubber.ts';
import type { Scrubbed } from '../compliance/scrubber.ts';
import type { Embedder } from './embedder.ts';
import { DEFAULT_CACHE_POLICY, wilsonLowerBound } from './store.ts';
import type { CacheEntry, CacheKey, CachePolicy, FixCacheStore, FixPatch } from './store.ts';
import { cmpScore } from '../reducer.ts';
import type { Score } from '../types.ts';

export interface FailureCtx {
  tenantId: string;
  /** Section 1 failure-set fingerprint. */
  fp: string;
  tool: string;
  code: string;
  lang: string;
  toolchain: string;
  /** Diagnostic message, already scrubbed. */
  message: Scrubbed;
  /** sha256 of the code region the diagnostic points at. */
  contextSha: string;
}

export type CacheDecision =
  | { kind: 'hit'; tier: 'exact' | 'semantic'; mode: 'apply_verbatim' | 'hint_llm'; entry: CacheEntry; similarity: number; confidence: number }
  | { kind: 'miss'; reason: 'none' | 'below_threshold' | 'low_confidence' | 'embedder_error' | 'store_error' };

export interface ResolveResult {
  source: 'cache' | 'llm';
  patch: FixPatch | null;
  decision: CacheDecision;
}

/** In-process single-flight. Across processes, put a Redis lock with a TTL in front of generate(). */
export class Coalescer {
  private inflight = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const ex = this.inflight.get(key);
    if (ex) return ex as Promise<T>;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

const keyOf = (c: FailureCtx, model: string): CacheKey => ({
  tenantId: c.tenantId, tool: c.tool, code: c.code, lang: c.lang, toolchain: c.toolchain, embedModel: model,
});

/**
 * Embed the normalized failure, not the raw log: paths, line numbers and scrubber tags must not move the vector.
 * tool/code/lang/toolchain are deliberately NOT in the text: they are exact-match gates in the store, and repeating
 * them would add a constant baseline that makes unrelated failures look similar.
 */
export function buildKeyText(c: FailureCtx): Scrubbed {
  // normalizeMessage only removes information, so the result is still scrubbed.
  return asScrubbed(normalizeMessage(c.message));
}

export class FixCache {
  private store: FixCacheStore;
  private embedder: Embedder;
  private policy: CachePolicy;
  private coalescer = new Coalescer();
  private onError: ((e: Error, op: 'find' | 'learn' | 'report') => void) | undefined;

  constructor(
    store: FixCacheStore, embedder: Embedder, policy: CachePolicy = DEFAULT_CACHE_POLICY,
    opts: { onError?: (e: Error, op: 'find' | 'learn' | 'report') => void } = {},
  ) {
    this.store = store;
    this.embedder = embedder;
    this.policy = policy;
    this.onError = opts.onError;
  }

  /** Bounded embedding call. If the timeout wins, the late result (or late rejection) is swallowed, never unhandled. */
  private async embedOne(text: Scrubbed): Promise<Float32Array> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const call = this.embedder.embed([text]);
    call.catch(() => undefined);
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`embedding timed out after ${this.policy.embedTimeoutMs}ms`)), this.policy.embedTimeoutMs);
      });
      const [v] = await Promise.race([call, timeout]);
      if (!v) throw new Error('embedder returned no vector');
      return v;
    } finally { clearTimeout(timer); }
  }

  /**
   * Confidence gate shared by both tiers. Two ways in, and recording a success can never make an entry LESS eligible:
   *  - never failed: needs near-identity (minSimilarityUntested), however many successes it has;
   *  - has a record: may match at the lower minSimilarity, but only with enough evidence (Wilson lower bound).
   */
  private accept(e: CacheEntry, similarity: number): { ok: boolean; confidence: number } {
    const n = e.successes + e.failures;
    const w = wilsonLowerBound(e.successes, e.failures);
    const confidence = n === 0 ? similarity : w;
    if (e.failures === 0 && similarity >= this.policy.minSimilarityUntested) return { ok: true, confidence };
    return { ok: n > 0 && similarity >= this.policy.minSimilarity && w >= this.policy.minWilson, confidence };
  }

  private hit(tier: 'exact' | 'semantic', e: CacheEntry, similarity: number, confidence: number, ctx: FailureCtx): CacheDecision {
    // Verbatim only when the code region is byte-identical AND scrubbing did not alter the diff.
    const verbatim = e.patch.contextSha === ctx.contextSha && !e.patch.containsRedaction;
    return { kind: 'hit', tier, mode: verbatim ? 'apply_verbatim' : 'hint_llm', entry: e, similarity, confidence };
  }

  async find(ctx: FailureCtx): Promise<CacheDecision> {
    const key = keyOf(ctx, this.embedder.model);

    let exact: CacheEntry | null;
    try { exact = await this.store.getExact(key, ctx.fp); }             // O(1): no embedding call, no LLM
    catch (e) { this.onError?.(e as Error, 'find'); return { kind: 'miss', reason: 'store_error' }; }
    let sawCandidate = false;
    if (exact) {
      sawCandidate = true;
      const a = this.accept(exact, 1);
      if (a.ok) return this.hit('exact', exact, 1, a.confidence, ctx);
    }

    let vec: Float32Array;
    try { vec = await this.embedOne(buildKeyText(ctx)); }
    catch (e) { this.onError?.(e as Error, 'find'); return { kind: 'miss', reason: 'embedder_error' }; }
    let cands: Awaited<ReturnType<FixCacheStore['search']>>;
    try { cands = await this.store.search(key, vec, this.policy.maxCandidates); }
    catch (e) { this.onError?.(e as Error, 'find'); return { kind: 'miss', reason: 'store_error' }; }

    let best: { e: CacheEntry; sim: number; conf: number; rank: number } | null = null;
    for (const { entry, similarity } of cands) {
      sawCandidate = true;
      if (similarity < this.policy.minSimilarity) continue;
      const a = this.accept(entry, similarity);
      if (!a.ok) continue;
      const rank = similarity + 0.1 * a.confidence;
      if (!best || rank > best.rank) best = { e: entry, sim: similarity, conf: a.confidence, rank };
    }
    if (best) return this.hit('semantic', best.e, best.sim, best.conf, ctx);
    if (!sawCandidate) return { kind: 'miss', reason: 'none' };
    return { kind: 'miss', reason: cands.some(c => c.similarity >= this.policy.minSimilarity) || exact ? 'low_confidence' : 'below_threshold' };
  }

  /**
   * Cache first, then exactly one generation per (tenant, fp) in flight. A verbatim hit skips the LLM entirely;
   * a hint hit still calls it, but `generate` receives the cached patch as a strong starting point.
   * The returned patch is a CANDIDATE: it enters the state machine at PATCH and must pass compile and tests.
   */
  resolve(ctx: FailureCtx, generate: (hint: CacheEntry | null) => Promise<FixPatch>): Promise<ResolveResult> {
    return this.coalescer.run(`${ctx.tenantId}/${ctx.fp}/${ctx.toolchain}`, async () => {
      const decision = await this.find(ctx);
      if (decision.kind === 'hit' && decision.mode === 'apply_verbatim') {
        return { source: 'cache' as const, patch: decision.entry.patch, decision };
      }
      const patch = await generate(decision.kind === 'hit' ? decision.entry : null);
      return { source: 'llm' as const, patch, decision };
    });
  }

  /** Only a fix that resolved this fingerprint AND strictly improved the Section 1 score is ever stored (`learn()`). Best effort. */
  async learn(a: { ctx: FailureCtx; patch: FixPatch; resolved: boolean; before: Score; after: Score }): Promise<CacheEntry | null> {
    if (!a.resolved || cmpScore(a.after, a.before) >= 0) return null;
    if (a.patch.diff.length > 64 * 1024) return null;                 // huge patches are not "fixes", they are rewrites
    try {
      const vec = await this.embedOne(buildKeyText(a.ctx));
      return await this.store.upsert(keyOf(a.ctx, this.embedder.model), a.ctx.fp, vec, a.patch);
    } catch (e) { this.onError?.(e as Error, 'learn'); return null; }
  }

  /** Report back after applying a cache-served patch. Failures quarantine bad entries automatically. Best effort. */
  async report(tenantId: string, entryId: string, ok: boolean): Promise<void> {
    try { await this.store.recordOutcome(tenantId, entryId, ok); }
    catch (e) { this.onError?.(e as Error, 'report'); }
  }
}
