export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOpts { failureThreshold: number; openMs: number; now?: () => number }

/** Per-provider circuit breaker: stop hammering a failing API; let exactly one probe through after openMs. */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private o: BreakerOpts;

  constructor(o: BreakerOpts) { this.o = o; }

  private now(): number { return (this.o.now ?? Date.now)(); }

  status(): BreakerState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.o.openMs) return 'half_open';
    return this.state;
  }

  retryInMs(): number {
    return this.state === 'open' ? Math.max(0, this.o.openMs - (this.now() - this.openedAt)) : 0;
  }

  canPass(): boolean {
    const s = this.status();
    if (s === 'closed') return true;
    if (s === 'open') return false;
    if (this.probing) return false;
    this.state = 'half_open';
    this.probing = true;
    return true;
  }

  success(): void { this.state = 'closed'; this.failures = 0; this.probing = false; }

  failure(): void {
    this.probing = false;
    if (this.state === 'half_open' || ++this.failures >= this.o.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
      this.failures = 0;
    }
  }
}

export class BreakerRegistry {
  private m = new Map<string, CircuitBreaker>();
  private o: BreakerOpts;
  constructor(o: BreakerOpts) { this.o = o; }
  get(provider: string): CircuitBreaker {
    let b = this.m.get(provider);
    if (!b) { b = new CircuitBreaker(this.o); this.m.set(provider, b); }
    return b;
  }
}
