import { DockerClient } from './client.ts';
import { Sandbox } from './sandbox.ts';
import type { Ident } from './sandbox.ts';
import { KeyedSemaphore } from './semaphore.ts';
import type { SandboxPolicy } from './policy.ts';

export class RuntimeUnavailable extends Error {}

interface Live { sandbox: Sandbox; release: () => void }

export class SandboxManager {
  private client: DockerClient;
  private policy: SandboxPolicy;
  private sem: KeyedSemaphore;
  private live = new Map<string, Live>();
  private inflight = new Map<string, Promise<Sandbox>>();
  private effective: SandboxPolicy | null = null;

  constructor(client: DockerClient, policy: SandboxPolicy) {
    this.client = client;
    this.policy = policy;
    this.sem = new KeyedSemaphore(policy.maxConcurrent, policy.maxPerTenant, policy.maxQueue);
  }

  /** Fail closed: never silently downgrade isolation in production. */
  private async effectivePolicy(): Promise<SandboxPolicy> {
    if (this.effective) return this.effective;
    const info = await this.client.info();
    const runtimes = Object.keys(info.Runtimes ?? {});
    if (runtimes.includes(this.policy.runtime)) {
      this.effective = this.policy;
    } else if (this.policy.allowRuncFallback && runtimes.includes('runc')) {
      console.error(`[nexus] WARNING: runtime "${this.policy.runtime}" not registered; falling back to runc (dev only)`);
      this.effective = { ...this.policy, runtime: 'runc' };
    } else {
      throw new RuntimeUnavailable(`runtime "${this.policy.runtime}" not registered with Docker (have: ${runtimes.join(', ')})`);
    }
    return this.effective;
  }

  /** Single-flight per run: concurrent callers share one creation instead of racing to create two containers. */
  async getOrCreate(ident: Ident): Promise<Sandbox> {
    const key = `${ident.tenantId}/${ident.runId}`;
    const existing = this.live.get(key);
    if (existing && !existing.sandbox.isDead) return existing.sandbox;
    if (existing) await this.destroy(ident);

    let p = this.inflight.get(key);
    if (!p) {
      p = this.create(key, ident).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async create(key: string, ident: Ident): Promise<Sandbox> {
    const release = await this.sem.acquire(ident.tenantId);     // may throw QueueFull
    try {
      const policy = await this.effectivePolicy();
      const sandbox = await Sandbox.create(this.client, policy, ident);
      this.live.set(key, { sandbox, release });
      return sandbox;
    } catch (e) {
      release();
      throw e;
    }
  }

  async destroy(ident: Ident): Promise<void> {
    const key = `${ident.tenantId}/${ident.runId}`;
    const l = this.live.get(key);
    if (!l) return;
    this.live.delete(key);
    try { await l.sandbox.destroy(); } finally { l.release(); }
  }

  /** Sweep containers past their TTL (orchestrator crashed, lease lost, etc.). */
  async reapOrphans(nowMs = Date.now()): Promise<number> {
    const list = await this.client.listByLabel('nexus.managed=true');
    let reaped = 0;
    for (const c of list) {
      const exp = Number(c.Labels['nexus.expires_at'] ?? 0);
      if (exp > 0 && nowMs / 1000 > exp + 30) {
        await this.client.removeContainer(c.Id).catch(() => undefined);
        reaped++;
      }
    }
    return reaped;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.live.values()].map(l => l.sandbox.destroy().finally(l.release)));
    this.live.clear();
  }

  stats(): { held: number; queued: number; live: number } {
    return { ...this.sem.stats(), live: this.live.size };
  }
}
