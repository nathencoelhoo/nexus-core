import type { Scrubbed } from '../compliance/scrubber.ts';

/**
 * Embedding calls are third-party egress, so the input type is `Scrubbed`: unscrubbed text does not compile.
 * `model` is stored with every vector; vectors from different models are not comparable and are never mixed.
 */
export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: Scrubbed[]): Promise<Float32Array[]>;
}

function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * Deterministic lexical baseline (signed feature hashing of word uni/bigrams and char trigrams, L2-normalized).
 * Not semantic: it exists for offline development and tests. Swap in a real model behind the same interface.
 */
export class HashingEmbedder implements Embedder {
  readonly model = 'hashing-v1';
  readonly dim: number;
  constructor(dim = 256) { this.dim = dim; }

  async embed(texts: Scrubbed[]): Promise<Float32Array[]> { return texts.map(t => this.one(t)); }

  private one(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const toks = text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
    const add = (f: string, w: number) => {
      const h = fnv1a(f);
      v[h % this.dim]! += (fnv1a(f, 0x9747b28c) & 1 ? 1 : -1) * w;
    };
    toks.forEach((t, i) => {
      add(`u:${t}`, 1);
      if (i > 0) add(`b:${toks[i - 1]}:${t}`, 1);
      for (let j = 0; j + 3 <= t.length; j++) add(`c:${t.slice(j, j + 3)}`, 0.3);
    });
    let n = 0; for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
