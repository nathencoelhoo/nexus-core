import type { Ec2Api, Ec2Instance, Ec2Params, RunInput } from '../../src/providers/aws/ec2.ts';
import { TAG_MANAGED } from '../../src/providers/aws/ec2.ts';

/** An error shaped like the ones the AWS SDK throws (`name` is the service error code, `$metadata` carries the HTTP status). */
export function awsError(name: string, status: number, message: string = name): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
}

interface Rec extends Ec2Instance { params: string; tags: Record<string, string>; createdAtCall: number }

/**
 * A fake EC2 that encodes AWS's DOCUMENTED RunInstances ClientToken behavior:
 *  - same token + same parameters returns the original instance, never a second one;
 *  - same token + different parameters fails with IdempotentParameterMismatch;
 *  - a token whose instance was terminated returns that terminated instance;
 *  - DescribeInstances is eventually consistent (`hideForCalls`).
 * It is only as right as that documentation: the opt-in live test is what checks the real service.
 */
export class FakeEc2Api implements Ec2Api {
  instances: Rec[] = [];
  calls: Array<{ op: string; token?: string }> = [];
  failNext: { error: Error; afterCreate?: boolean } | null = null;
  hideForCalls = 0;
  private n = 0;
  private seq = 0;

  private sig(i: Ec2Params): string {
    return JSON.stringify([i.imageId, i.instanceType, i.subnetId ?? null, [...(i.securityGroupIds ?? [])].sort()]);
  }
  private view(r: Rec): Ec2Instance { return { instanceId: r.instanceId, state: r.state, token: r.token }; }

  async runInstance(i: RunInput): Promise<Ec2Instance> {
    this.calls.push({ op: 'run', token: i.token });
    this.n++;
    const fail = this.failNext;
    if (fail) this.failNext = null;
    const existing = this.instances.find(x => x.token === i.token);
    if (existing) {
      if (fail) throw fail.error;
      if (existing.params !== this.sig(i)) throw awsError('IdempotentParameterMismatch', 400, 'the client token was used with different parameters');
      return this.view(existing);
    }
    if (fail && !fail.afterCreate) throw fail.error;
    const rec: Rec = { instanceId: `i-${String(++this.seq).padStart(17, '0')}`, state: 'pending', token: i.token, params: this.sig(i), tags: { ...i.tags }, createdAtCall: this.n };
    this.instances.push(rec);
    if (fail) throw fail.error;                                // the instance exists, the client sees an error
    return this.view(rec);
  }

  async findByToken(token: string): Promise<Ec2Instance[]> {
    this.calls.push({ op: 'find', token });
    this.n++;
    return this.instances.filter(x => x.token === token && this.n - x.createdAtCall > this.hideForCalls).map(x => this.view(x));
  }

  async terminate(instanceId: string): Promise<void> {
    this.calls.push({ op: 'terminate' });
    const r = this.instances.find(x => x.instanceId === instanceId);
    if (r) r.state = 'terminated';
  }

  async *listManaged(): AsyncIterable<Ec2Instance> {
    this.calls.push({ op: 'list' });
    for (const r of [...this.instances]) if (r.tags[TAG_MANAGED] === 'true') yield this.view(r);
  }

  /** An instance that exists in the cloud with this token, regardless of what the ledger says. */
  seed(token: string, state = 'running'): Ec2Instance {
    const rec: Rec = { instanceId: `i-${String(++this.seq).padStart(17, '0')}`, state, token, params: 'seed', tags: { [TAG_MANAGED]: 'true' }, createdAtCall: this.n };
    this.instances.push(rec);
    return this.view(rec);
  }

  live(): string[] { return this.instances.filter(i => i.state !== 'terminated').map(i => i.token); }
}
