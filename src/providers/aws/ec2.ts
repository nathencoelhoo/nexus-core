import { ProviderHttpError } from '../../jobs/errors.ts';
import type { ExternalAction } from '../../jobs/runner.ts';
import { mapAwsError } from './awsErrors.ts';

export interface Ec2Params {
  imageId: string;
  instanceType: string;
  subnetId?: string;
  securityGroupIds?: string[];
  name?: string;
}
export interface Ec2Instance { instanceId: string; state: string; token: string }
export interface RunInput extends Ec2Params { token: string; tags: Record<string, string> }

/** The narrow surface the action needs. The SDK implements it (sdk.ts); tests implement it with a fake. */
export interface Ec2Api {
  runInstance(input: RunInput, signal: AbortSignal): Promise<Ec2Instance>;
  /** Instances carrying this token tag, terminated ones included so the caller can tell them apart. */
  findByToken(token: string, signal: AbortSignal): Promise<Ec2Instance[]>;
  /** Idempotent: an instance that is already gone is success. */
  terminate(instanceId: string, signal: AbortSignal): Promise<void>;
  /** Every instance this system manages (tag nexus-managed=true) that carries a token tag. */
  listManaged(signal: AbortSignal): AsyncIterable<Ec2Instance>;
}

export const TAG_TOKEN = 'nexus-token';
export const TAG_MANAGED = 'nexus-managed';
const DEAD = new Set(['terminated', 'shutting-down']);
const AMI = /^ami-[0-9a-f]{8,17}$/;
const ITYPE = /^[a-z0-9]+\.[a-z0-9]+$/;

export interface Ec2ActionOpts {
  /** Cost guard: an LLM-driven system must not be able to ask for a p5.48xlarge. Reject anything else before calling AWS. */
  allowedInstanceTypes?: string[];
}

const bad = (message: string): never => { throw new ProviderHttpError(400, message); };

/**
 * EC2 RunInstances as an idempotent action.
 *  - Primary guarantee: the ledger key is sent as ClientToken, so EC2 itself dedupes a repeated launch (max 64 chars: the key is 64 hex).
 *  - Secondary: a tag carries the same token, so `lookup` can adopt an instance after a crash. DescribeInstances is eventually
 *    consistent, so lookup can legitimately see nothing right after a launch; re-running `execute` with the same token is then still safe.
 *  - A token that already belongs to a TERMINATED instance makes EC2 return that dead instance. That is surfaced as a permanent failure,
 *    not adopted as success.
 */
export function ec2RunInstanceAction(api: Ec2Api, opts: Ec2ActionOpts = {}): ExternalAction<Ec2Params, Ec2Instance> {
  const run = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { throw mapAwsError(e); } };
  return {
    name: 'aws.ec2.run_instance',
    provider: 'aws',
    nativeIdempotency: true,

    async execute(params, ctx) {
      if (!AMI.test(params.imageId)) bad(`invalid imageId: ${JSON.stringify(params.imageId)}`);
      if (!ITYPE.test(params.instanceType)) bad(`invalid instanceType: ${JSON.stringify(params.instanceType)}`);
      if (opts.allowedInstanceTypes && !opts.allowedInstanceTypes.includes(params.instanceType)) {
        bad(`instance type ${params.instanceType} is not in the allowlist (${opts.allowedInstanceTypes.join(', ')})`);
      }
      const tags: Record<string, string> = { [TAG_TOKEN]: ctx.token, [TAG_MANAGED]: 'true' };
      if (params.name) tags.Name = params.name;
      const inst = await run(() => api.runInstance({ ...params, token: ctx.token, tags }, ctx.signal));
      if (DEAD.has(inst.state)) {
        throw new ProviderHttpError(400, `instance ${inst.instanceId} for this ClientToken is already ${inst.state}; EC2 returns the original instance when a token is reused, so a replacement cannot be created under the same key`);
      }
      return inst;
    },

    async lookup(token, signal) {
      const found = await run(() => api.findByToken(token, signal));
      return found.find(i => !DEAD.has(i.state)) ?? null;
    },

    async compensate(resource, signal) { await run(() => api.terminate(resource.instanceId, signal)); },

    async *inventory(signal) {
      for await (const i of api.listManaged(signal)) {
        if (!DEAD.has(i.state)) yield { token: i.token, resource: i };
      }
    },
  };
}
