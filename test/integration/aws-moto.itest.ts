import { before } from 'node:test';
import assert from 'node:assert/strict';
import { DescribeImagesCommand, DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { itest, uuid } from './_helpers.ts';
import { SdkEc2Api } from '../../src/providers/aws/sdk.ts';
import { ec2RunInstanceAction, TAG_MANAGED, TAG_TOKEN } from '../../src/providers/aws/ec2.ts';
import type { Ec2Params } from '../../src/providers/aws/ec2.ts';
import { MemoryLedgerStore } from '../../src/jobs/ledger.ts';
import { runIdempotent } from '../../src/jobs/runner.ts';
import { RetryableFailure } from '../../src/jobs/errors.ts';
import { reconcile } from '../../src/jobs/reconciler.ts';
import { idempotencyKey } from '../../src/jobs/idempotency.ts';

/**
 * The real AWS SDK against the `moto` EC2 emulator (CI service container): this proves the wire contract of the adapter
 * (tags, ClientToken, filters, terminate, pagination, real error shapes). moto is NOT guaranteed to enforce ClientToken
 * idempotency, so the dedupe guarantee itself is only asserted by the opt-in live test (aws-live.itest.ts).
 */
const ENABLED = process.env.NEXUS_AWS_EMULATOR === '1';
const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:5000';
const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
const api = new SdkEc2Api({ region: 'us-east-1', endpoint, credentials });
const raw = new EC2Client({ region: 'us-east-1', endpoint, credentials, maxAttempts: 1 });
const signal = () => new AbortController().signal;
const etest = (name: string, fn: () => Promise<void>) => itest(name, fn, ENABLED);
let ami = '';

if (ENABLED) {
  before(async () => {
    const r = await raw.send(new DescribeImagesCommand({}));
    ami = r.Images?.[0]?.ImageId ?? '';
    assert.ok(ami, 'the emulator returned no AMIs');
  });
}

const params = (): Ec2Params => ({ imageId: ami, instanceType: 't3.nano', name: `itest-${uuid().slice(0, 8)}` });
const id = () => ({ tenantId: 't1', runId: uuid(), stepId: '0:1' });

class FlakyLedger extends MemoryLedgerStore {
  failSucceed = 0;
  override async succeed(k: string, a: number, r: unknown) {
    if (this.failSucceed-- > 0) throw new Error('db down');
    return super.succeed(k, a, r);
  }
}

etest('launch through the real SDK: tags and ClientToken reach the service', async () => {
  const p = params(), ident = id();
  const out = await runIdempotent(ec2RunInstanceAction(api), p, ident, { ledger: new MemoryLedgerStore() });
  assert.match(out.result.instanceId, /^i-/);
  const d = await raw.send(new DescribeInstancesCommand({ InstanceIds: [out.result.instanceId] }));
  const inst = d.Reservations?.[0]?.Instances?.[0];
  assert.ok(inst, 'instance not found');
  const tags = Object.fromEntries((inst.Tags ?? []).map(t => [t.Key, t.Value]));
  assert.equal(tags[TAG_TOKEN], out.key);
  assert.equal(tags[TAG_MANAGED], 'true');
  assert.equal(tags.Name, p.name);
  if (inst.ClientToken !== undefined && inst.ClientToken !== '') assert.equal(inst.ClientToken, out.key);   // not every emulator echoes it
});

etest('crash after launch: lookup by tag adopts the instance, one instance per token', async () => {
  const p = params(), ident = id();
  const ledger = new FlakyLedger(); ledger.failSucceed = 1;
  const act = ec2RunInstanceAction(api);
  await assert.rejects(runIdempotent(act, p, ident, { ledger }), RetryableFailure);
  const out = await runIdempotent(act, p, ident, { ledger });
  assert.equal(out.deduped, true);
  const found = await api.findByToken(out.key, signal());
  assert.equal(found.length, 1);
  assert.equal(found[0]!.instanceId, out.result.instanceId);
});

etest('ClientToken dedupe by the emulator (informational: moto may not enforce it; the live test does)', async () => {
  const p = params();
  const token = idempotencyKey({ ...id(), action: 'aws.ec2.run_instance', params: p });
  const input = { ...p, token, tags: { [TAG_TOKEN]: token, [TAG_MANAGED]: 'true' } };
  const a = await api.runInstance(input, signal());
  const b = await api.runInstance(input, signal());
  console.log(a.instanceId === b.instanceId ? 'emulator DEDUPES a repeated ClientToken' : 'emulator does NOT dedupe a repeated ClientToken (live test covers real EC2)');
  assert.match(a.instanceId, /^i-/);
  assert.match(b.instanceId, /^i-/);
});

etest('terminate is idempotent, including for an instance that does not exist (real error shape)', async () => {
  const p = params(), ident = id();
  const out = await runIdempotent(ec2RunInstanceAction(api), p, ident, { ledger: new MemoryLedgerStore() });
  await api.terminate(out.result.instanceId, signal());
  await api.terminate(out.result.instanceId, signal());
  const after = await api.findByToken(out.key, signal());
  assert.ok(['terminated', 'shutting-down'].includes(after[0]!.state), after[0]!.state);
  await api.terminate('i-0123456789abcdef0', signal());                    // never existed
});

etest('inventory and reconciler find and terminate an orphan through the real SDK', async () => {
  const act = ec2RunInstanceAction(api);
  const p = params();
  const token = idempotencyKey({ ...id(), action: act.name, params: p });
  const launched = await api.runInstance({ ...p, token, tags: { [TAG_TOKEN]: token, [TAG_MANAGED]: 'true' } }, signal());   // no ledger row
  const seen: string[] = [];
  for await (const x of act.inventory!(signal())) seen.push(x.token);
  assert.ok(seen.includes(token), 'inventory did not list the managed instance');

  const rep = await reconcile({ ledger: new MemoryLedgerStore(), actions: new Map([[act.name, act]]), stuckMs: 1000, isRunDead: async () => false });
  assert.ok(rep.orphansDeleted.includes(token), JSON.stringify(rep));
  assert.deepEqual(rep.errors, []);
  const state = (await api.findByToken(token, signal()))[0]!.state;
  assert.ok(['terminated', 'shutting-down'].includes(state), `${launched.instanceId} is ${state}`);
});
