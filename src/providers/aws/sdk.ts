import { DescribeInstancesCommand, EC2Client, RunInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import type { Filter, Instance, RunInstancesCommandInput } from '@aws-sdk/client-ec2';
import { TAG_MANAGED, TAG_TOKEN } from './ec2.ts';
import type { Ec2Api, Ec2Instance, RunInput } from './ec2.ts';

export interface SdkEc2Opts {
  region: string;
  /** For emulators (moto, LocalStack). Leave unset for real AWS. */
  endpoint?: string;
  /** Omit to use the SDK's default credential chain (environment, SSO, instance role). */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

const tagValue = (i: Instance, key: string): string | undefined => i.Tags?.find(t => t.Key === key)?.Value;

function toInstance(i: Instance, fallbackToken = ''): Ec2Instance {
  return { instanceId: i.InstanceId ?? '', state: i.State?.Name ?? 'unknown', token: tagValue(i, TAG_TOKEN) ?? fallbackToken };
}

/**
 * Thin AWS SDK v3 wrapper. It throws raw SDK errors; translation to retry classes happens in the action (awsErrors.ts).
 * `maxAttempts: 1` is deliberate: this system's runner, ledger and circuit breaker own retries. A hidden SDK retry would
 * be invisible to all three.
 */
export class SdkEc2Api implements Ec2Api {
  private client: EC2Client;

  constructor(o: SdkEc2Opts) {
    this.client = new EC2Client({
      region: o.region,
      maxAttempts: 1,
      ...(o.endpoint ? { endpoint: o.endpoint } : {}),
      ...(o.credentials ? { credentials: o.credentials } : {}),
    });
  }

  async runInstance(i: RunInput, signal: AbortSignal): Promise<Ec2Instance> {
    const input: RunInstancesCommandInput = {
      ImageId: i.imageId,
      InstanceType: i.instanceType as RunInstancesCommandInput['InstanceType'],
      MinCount: 1,
      MaxCount: 1,
      ClientToken: i.token,
      InstanceInitiatedShutdownBehavior: 'terminate',          // an instance that shuts itself down stops costing money
      MetadataOptions: { HttpTokens: 'required' },             // IMDSv2 only
      TagSpecifications: [{ ResourceType: 'instance', Tags: Object.entries(i.tags).map(([Key, Value]) => ({ Key, Value })) }],
      ...(i.subnetId ? { SubnetId: i.subnetId } : {}),
      ...(i.securityGroupIds?.length ? { SecurityGroupIds: i.securityGroupIds } : {}),
    };
    const out = await this.client.send(new RunInstancesCommand(input), { abortSignal: signal });
    const inst = out.Instances?.[0];
    if (!inst?.InstanceId) throw new Error('RunInstances returned no instance');
    return toInstance(inst, i.token);
  }

  async findByToken(token: string, signal: AbortSignal): Promise<Ec2Instance[]> {
    const out = await this.client.send(
      new DescribeInstancesCommand({ Filters: [{ Name: `tag:${TAG_TOKEN}`, Values: [token] }] }), { abortSignal: signal });
    return (out.Reservations ?? []).flatMap(r => r.Instances ?? []).map(i => toInstance(i, token));
  }

  async terminate(instanceId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }), { abortSignal: signal });
    } catch (e) {
      if ((e as { name?: string; Code?: string }).Code === 'InvalidInstanceID.NotFound' || (e as { name?: string }).name === 'InvalidInstanceID.NotFound') return;
      throw e;
    }
  }

  async *listManaged(signal: AbortSignal): AsyncIterable<Ec2Instance> {
    const Filters: Filter[] = [{ Name: `tag:${TAG_MANAGED}`, Values: ['true'] }];
    let NextToken: string | undefined;
    do {
      const out = await this.client.send(new DescribeInstancesCommand({ Filters, MaxResults: 100, NextToken }), { abortSignal: signal });
      for (const r of out.Reservations ?? []) {
        for (const i of r.Instances ?? []) { const inst = toInstance(i); if (inst.token) yield inst; }
      }
      NextToken = out.NextToken;
    } while (NextToken);
  }
}
