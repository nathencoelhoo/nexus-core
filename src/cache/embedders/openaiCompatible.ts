import type { Scrubbed } from '../../compliance/scrubber.ts';
import type { Embedder } from '../embedder.ts';

export class EmbeddingError extends Error {
  status?: number;
  constructor(message: string, status?: number) { super(message); this.status = status; }
}

export interface OpenAICompatibleOpts {
  /** e.g. https://api.openai.com/v1 , or a local Ollama / vLLM / LiteLLM server. */
  baseUrl: string;
  model: string;
  dim: number;
  apiKey?: string;
  /** Send `dimensions` (OpenAI text-embedding-3 and several compatible servers truncate server-side). */
  requestDimensions?: boolean;
  batchSize?: number;
  timeoutMs?: number;
  /** Models have token limits; very long diagnostics are cut here, after scrubbing. */
  maxChars?: number;
  fetchImpl?: typeof fetch;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Embeddings from any server speaking POST {baseUrl}/embeddings (OpenAI, Ollama, vLLM, LiteLLM, ...).
 * This is third-party egress, so the input type is `Scrubbed`, and the endpoint must be https unless it is loopback.
 * The API key is only ever placed in the Authorization header: never in a URL, log line or error message.
 */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  private url: string;
  private upstreamModel: string;
  private apiKey: string | undefined;
  private requestDimensions: boolean;
  private batchSize: number;
  private timeoutMs: number;
  private maxChars: number;
  private fetchImpl: typeof fetch;

  constructor(o: OpenAICompatibleOpts) {
    const u = new URL(o.baseUrl);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
      throw new Error('embedding endpoint must use https (plain http is allowed only for loopback)');
    }
    if (u.username || u.password) throw new Error('credentials must not be embedded in the embedding endpoint URL');
    this.url = o.baseUrl.replace(/\/+$/, '');
    this.upstreamModel = o.model;
    this.dim = o.dim;
    this.model = `openai-compatible:${o.model}:${o.dim}`;      // dimension is part of the identity: truncation changes the vectors
    this.apiKey = o.apiKey;
    this.requestDimensions = o.requestDimensions ?? false;
    this.batchSize = o.batchSize ?? 64;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.maxChars = o.maxChars ?? 4_000;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async embed(texts: Scrubbed[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      out.push(...await this.post(texts.slice(i, i + this.batchSize)));
    }
    return out;
  }

  private async post(batch: Scrubbed[]): Promise<Float32Array[]> {
    const body: Record<string, unknown> = {
      model: this.upstreamModel,
      input: batch.map(t => (t.length > this.maxChars ? t.slice(0, this.maxChars) : t)),
    };
    if (this.requestDimensions) body.dimensions = this.dim;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let json: unknown;
    try {
      const res = await this.fetchImpl(`${this.url}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      // The response body is deliberately not included in errors: providers sometimes echo the request.
      if (!res.ok) throw new EmbeddingError(`embedding endpoint returned HTTP ${res.status}`, res.status);
      json = await res.json();
    } catch (e) {
      if (e instanceof EmbeddingError) throw e;
      throw new EmbeddingError(ac.signal.aborted ? `embedding request timed out after ${this.timeoutMs}ms` : `embedding request failed: ${(e as Error).name}`);
    } finally { clearTimeout(timer); }

    const data = (json as { data?: Array<{ index?: number; embedding?: unknown }> } | null)?.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new EmbeddingError(`expected ${batch.length} embeddings, got ${Array.isArray(data) ? data.length : 'none'}`);
    }
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((d, i) => {
      const e = d.embedding;
      if (!Array.isArray(e) || e.length !== this.dim || !e.every(x => typeof x === 'number' && Number.isFinite(x))) {
        throw new EmbeddingError(`embedding #${i} is not ${this.dim} finite numbers (got ${Array.isArray(e) ? e.length : typeof e})`);
      }
      const v = Float32Array.from(e as number[]);
      let n = 0; for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      for (let k = 0; k < v.length; k++) v[k]! /= n;
      return v;
    });
  }
}
