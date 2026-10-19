import type { Scrubbed } from '../../compliance/scrubber.ts';
import type { Embedder } from '../embedder.ts';

type Extractor = (input: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>;

/**
 * A real sentence-embedding model running locally through ONNX (transformers.js). No API key, no network after the
 * first download, and no third-party egress at all: the strongest answer to "what leaves the trust boundary?".
 *
 * `@huggingface/transformers` is an OPTIONAL peer dependency, loaded lazily: install it only where you use this class.
 * The first call downloads the model (about 25 MB for the default); call `warmup()` at startup so the first cache lookup
 * is not slow (FixCache treats a slow embedder as a miss rather than blocking a run).
 */
export class TransformersEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  private modelId: string;
  private batchSize: number;
  private extractor: Promise<Extractor> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: { model?: string; dim?: number; batchSize?: number } = {}) {
    this.modelId = o.model ?? 'Xenova/all-MiniLM-L6-v2';
    this.dim = o.dim ?? 384;
    this.batchSize = o.batchSize ?? 32;
    this.model = `transformers:${this.modelId}`;
  }

  private load(): Promise<Extractor> {
    if (!this.extractor) {
      const spec = '@huggingface/transformers';          // non-literal: no compile-time dependency on the package
      this.extractor = import(spec)
        .then(m => m.pipeline('feature-extraction', this.modelId) as Promise<Extractor>)
        .catch((e: Error) => {
          this.extractor = null;                          // allow a later retry
          throw new Error(`could not load embedding model ${this.modelId} (is @huggingface/transformers installed?): ${e.message}`);
        });
    }
    return this.extractor;
  }

  async warmup(): Promise<void> { await this.load(); }

  /** Calls are serialized: one ONNX session, and concurrent batches only add memory pressure. */
  embed(texts: Scrubbed[]): Promise<Float32Array[]> {
    const run = async (): Promise<Float32Array[]> => {
      const ex = await this.load();
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += this.batchSize) {
        const t = await ex(texts.slice(i, i + this.batchSize), { pooling: 'mean', normalize: true });
        for (const row of t.tolist()) {
          if (row.length !== this.dim) throw new Error(`model produced ${row.length} dimensions, expected ${this.dim}`);
          out.push(Float32Array.from(row));
        }
      }
      return out;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}
