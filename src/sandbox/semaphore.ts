export class QueueFull extends Error {}

interface Waiter { key: string; resolve: (release: () => void) => void }

/**
 * Global + per-key concurrency limit with a bounded FIFO wait queue.
 * A full queue rejects immediately (load shedding): this is the backpressure signal
 * the task queue layer reacts to, instead of letting latency grow without bound.
 */
export class KeyedSemaphore {
  private held = 0;
  private heldBy = new Map<string, number>();
  private queue: Waiter[] = [];
  private max: number;
  private perKey: number;
  private maxQueue: number;

  constructor(max: number, perKey: number, maxQueue: number) {
    this.max = max;
    this.perKey = perKey;
    this.maxQueue = maxQueue;
  }

  acquire(key: string): Promise<() => void> {
    if (this.canRun(key)) return Promise.resolve(this.grant(key));
    if (this.queue.length >= this.maxQueue) return Promise.reject(new QueueFull(`wait queue full (${this.maxQueue})`));
    return new Promise(resolve => { this.queue.push({ key, resolve }); });
  }

  stats(): { held: number; queued: number } { return { held: this.held, queued: this.queue.length }; }

  private canRun(key: string): boolean {
    return this.held < this.max && (this.heldBy.get(key) ?? 0) < this.perKey;
  }

  private grant(key: string): () => void {
    this.held++;
    this.heldBy.set(key, (this.heldBy.get(key) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;                 // release is idempotent
      done = true;
      this.held--;
      const n = (this.heldBy.get(key) ?? 1) - 1;
      if (n <= 0) this.heldBy.delete(key); else this.heldBy.set(key, n);
      this.pump();
    };
  }

  /** Scan the queue so one saturated tenant cannot head-of-line block the others. */
  private pump(): void {
    let i = 0;
    while (i < this.queue.length && this.held < this.max) {
      const w = this.queue[i]!;
      if (this.canRun(w.key)) { this.queue.splice(i, 1); w.resolve(this.grant(w.key)); } else i++;
    }
  }
}
