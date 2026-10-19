import { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { itest, sleep } from './_helpers.ts';
import { SdkEc2Api } from '../../src/providers/aws/sdk.ts';
import { TAG_MANAGED, TAG_TOKEN } from '../../src/providers/aws/ec2.ts';
import type { RunInput } from '../../src/providers/aws/ec2.ts';
import { mapAwsError } from '../../src/providers/aws/awsErrors.ts';
import { classifyError } from '../../src/jobs/errors.ts';

/**
 * LIVE AWS. Opt-in, never run in CI. This is the only test that checks EC2's real ClientToken behavior.
 *
 *   NEXUS_AWS_LIVE=1 AWS_REGION=us-east-1 NEXUS_AWS_AMI=ami-... npm run test:aws-live
 *
 * It launches t3.nano instances (about $0.005/hour each; tests live for minutes) and terminates every instance it
 * launched in an `after` hook. Use a sandbox account, with credentials from the normal AWS chain. If a run is killed
 * halfway, look for instances tagged nexus-itest=1 and terminate them.
 */
const ENABLED = process.env.NEXUS_AWS_LIVE === '1';
const ami = process.env.NEXUS_AWS_AMI ?? '';
const api = new SdkEc2Api({ region: process.env.AWS_REGION ?? 'us-east-1' });
const signal = () => AbortSignal.timeout(60_000);
const launched = new Set<string>();
const ltest = (name: string, fn: () => Promise<void>) => itest(name, fn, ENABLED);

if (ENABLED) {
  after(async () => {
    for (const idv of launched) {
      try { await api.terminate(idv, signal()); } catch (e) { console.error(`FAILED TO TERMINATE ${idv}: terminate it manually!`, (e as Error).message); }
    }
  });
}

const newToken = () => createHash('sha256').update(randomUUID()).digest('hex');           // 64 hex chars, like a ledger key
const input = (token: string, instanceType = 't3.nano'): RunInput =>
  ({ imageId: ami, instanceType, token, tags: { [TAG_TOKEN]: token, [TAG_MANAGED]: 'true', 'nexus-itest': '1' } });

ltest('EC2 returns the SAME instance for a repeated ClientToken with identical parameters', async () => {
  assert.ok(ami, 'set NEXUS_AWS_AMI');
  const token = newToken();
  const a = await api.runInstance(input(token), signal());
  launched.add(a.instanceId);
  const b = await api.runInstance(input(token), signal());
  launched.add(b.instanceId);
  assert.equal(b.instanceId, a.instanceId, 'EC2 created a second instance for the same ClientToken');
});

ltest('the same ClientToken with different parameters is rejected, and classified permanent', async () => {
  const token = newToken();
  launched.add((await api.runInstance(input(token), signal())).instanceId);
  let err: unknown;
  try { launched.add((await api.runInstance(input(token, 't3.micro'), signal())).instanceId); } catch (e) { err = e; }
  assert.ok(err, 'EC2 accepted a different instance type under the same token');
  assert.equal((err as { name?: string }).name, 'IdempotentParameterMismatch');
  assert.equal(classifyError(mapAwsError(err)).cls, 'permanent');
});

ltest('DescribeInstances by tag finds a new instance (reporting the consistency lag)', async () => {
  const token = newToken();
  launched.add((await api.runInstance(input(token), signal())).instanceId);
  const t0 = Date.now();
  for (;;) {
    const found = await api.findByToken(token, signal());
    if (found.length === 1) break;
    assert.ok(Date.now() - t0 < 60_000, 'the instance never became visible to a tag filter');
    await sleep(500);
  }
  console.log(`tag lookup became consistent after ${Date.now() - t0} ms`);
});

ltest('a token whose instance was terminated returns the terminated instance (what ec2.ts relies on)', async () => {
  const token = newToken();
  const a = await api.runInstance(input(token), signal());
  launched.add(a.instanceId);
  await api.terminate(a.instanceId, signal());
  const t0 = Date.now();
  while ((await api.findByToken(token, signal()))[0]?.state !== 'terminated') {
    assert.ok(Date.now() - t0 < 180_000, 'instance did not reach terminated');
    await sleep(2_000);
  }
  const again = await api.runInstance(input(token), signal());
  assert.equal(again.instanceId, a.instanceId);
  assert.ok(['terminated', 'shutting-down'].includes(again.state), again.state);
});
