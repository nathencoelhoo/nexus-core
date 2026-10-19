import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awsError, FakeEc2Api } from './helpers/fakeEc2.ts';
import { ec2RunInstanceAction, TAG_MANAGED, TAG_TOKEN } from '../src/providers/aws/ec2.ts';
import type { Ec2Instance, Ec2Params } from '../src/providers/aws/ec2.ts';
import { mapAwsError } from '../src/providers/aws/awsErrors.ts';
import { classifyError, InFlightError, PermanentFailure, ProviderHttpError, RetryableFailure } from '../src/jobs/errors.ts';
import { MemoryLedgerStore } from '../src/jobs/ledger.ts';
import { runIdempotent } from '../src/jobs/runner.ts';
import { reconcile } from '../src/jobs/reconciler.ts';
import { idempotencyKey } from '../src/jobs/idempotency.ts';

const P: Ec2Params = { imageId: 'ami-0123456789abcdef0', instanceType: 't3.nano', name: 'worker-1' };
const id = { tenantId: 't1', runId: 'r1', stepId: '0:1' };
const keyFor = (p: Ec2Params = P) => idempotencyKey({ ...id, action: 'aws.ec2.run_instance', params: p });

class FlakyLedger extends MemoryLedgerStore {
  failSucceed = 0;
  override async succeed(k: string, a: number, r: unknown) {
    if (this.failSucceed-- > 0) throw new Error('db down');
    return super.succeed(k, a, r);
  }
}

// ---- error mapping, through classifyError (the thing the retry machinery actually uses) ---------------------------------
test('AWS errors map to retry classes', () => {
  const cls = (e: unknown) => classifyError(mapAwsError(e)).cls;
  assert.equal(cls(awsError('RequestLimitExceeded', 503)), 'throttled');
  assert.equal(cls(awsError('Throttling', 400)), 'throttled');
  assert.equal(cls(awsError('UnauthorizedOperation', 403)), 'auth');
  assert.equal(cls(awsError('AuthFailure', 401)), 'auth');
  assert.equal(cls(awsError('InvalidClientTokenId', 403)), 'auth');            // not mistaken for a parameter error
  assert.equal(cls(awsError('InstanceLimitExceeded', 400)), 'auth');           // quota: needs a human
  assert.equal(cls(awsError('IdempotentParameterMismatch', 400)), 'permanent');
  assert.equal(cls(awsError('InvalidAMIID.NotFound', 400)), 'permanent');
  assert.equal(cls(awsError('InvalidParameterValue', 400)), 'permanent');
  assert.equal(cls(awsError('InsufficientInstanceCapacity', 500)), 'ambiguous');
  assert.equal(cls(awsError('InternalError', 500)), 'ambiguous');
  assert.equal(cls(awsError('SomethingNew', 502)), 'ambiguous');               // unknown name: fall back to the status
  assert.equal(cls(awsError('SomethingNew', 404)), 'permanent');
  assert.equal(cls(new DOMException('t', 'TimeoutError')), 'ambiguous');       // passed through untouched
  assert.equal(cls(Object.assign(new Error('x'), { code: 'ECONNRESET' })), 'ambiguous');
  const mapped = mapAwsError(awsError('IdempotentParameterMismatch', 400)) as ProviderHttpError;
  assert.match(mapped.message, /key-derivation bug/);
  assert.ok(mapped.cause instanceof Error);                                    // the original error is preserved
});

// ---- the action, driven by the real runner and ledger, against a fake with AWS's documented token semantics -------------
test('launch sends the ledger key as ClientToken and tags the instance with it', async () => {
  const api = new FakeEc2Api(); const ledger = new MemoryLedgerStore();
  const out = await runIdempotent(ec2RunInstanceAction(api), P, id, { ledger });
  assert.equal(out.key, keyFor());
  assert.equal(api.calls[0]!.token, out.key);
  assert.equal(api.calls[0]!.token!.length, 64);                               // EC2's ClientToken limit
  const inst = api.instances[0]!;
  assert.equal(inst.tags[TAG_TOKEN], out.key);
  assert.equal(inst.tags[TAG_MANAGED], 'true');
  assert.equal(inst.tags.Name, 'worker-1');
  assert.equal(out.result.instanceId, inst.instanceId);
});

test('replaying a finished step is a ledger dedupe: no second API call at all', async () => {
  const api = new FakeEc2Api(); const ledger = new MemoryLedgerStore();
  const act = ec2RunInstanceAction(api);
  await runIdempotent(act, P, id, { ledger });
  const again = await runIdempotent(act, P, id, { ledger });
  assert.equal(again.deduped, true);
  assert.equal(api.instances.length, 1);
  assert.equal(api.calls.filter(c => c.op === 'run').length, 1);
});

test('crash after launch, describe not yet consistent: the retry re-sends the SAME token and EC2 dedupes', async () => {
  const api = new FakeEc2Api(); api.hideForCalls = 5;                          // lookup will see nothing for a while
  const ledger = new FlakyLedger(); ledger.failSucceed = 1;
  const act = ec2RunInstanceAction(api);
  await assert.rejects(runIdempotent(act, P, id, { ledger }), RetryableFailure);
  const out = await runIdempotent(act, P, id, { ledger });
  const runs = api.calls.filter(c => c.op === 'run');
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.token, runs[1]!.token);                                // identical token on the retry
  assert.equal(api.instances.length, 1);                                       // one instance, not two
  assert.equal(out.result.instanceId, api.instances[0]!.instanceId);
});

test('crash after launch, describe consistent: lookup adopts the instance and EC2 is not asked to launch again', async () => {
  const api = new FakeEc2Api();
  const ledger = new FlakyLedger(); ledger.failSucceed = 1;
  const act = ec2RunInstanceAction(api);
  await assert.rejects(runIdempotent(act, P, id, { ledger }), RetryableFailure);
  const out = await runIdempotent(act, P, id, { ledger });
  assert.equal(out.deduped, true);
  assert.equal(api.calls.filter(c => c.op === 'run').length, 1);
  assert.equal(api.instances.length, 1);
});

test('a ClientToken reused with different parameters is a permanent failure (and a bug worth surfacing)', async () => {
  const api = new FakeEc2Api(); const ledger = new MemoryLedgerStore();
  api.seed(keyFor());                                                          // the token is already bound to other parameters
  await assert.rejects(runIdempotent(ec2RunInstanceAction(api), P, id, { ledger }),
    (e: unknown) => e instanceof PermanentFailure && e.errorClass === 'permanent' && /ClientToken/.test(e.message));
  assert.equal((await ledger.get(keyFor()))?.status, 'FAILED');
});

test('a token whose instance was terminated is NOT adopted as success', async () => {
  const api = new FakeEc2Api(); const ledger = new FlakyLedger(); ledger.failSucceed = 1;
  const act = ec2RunInstanceAction(api);
  await assert.rejects(runIdempotent(act, P, id, { ledger }), RetryableFailure);
  api.instances[0]!.state = 'terminated';                                      // killed out of band before we recorded it
  await assert.rejects(runIdempotent(act, P, id, { ledger }),
    (e: unknown) => e instanceof PermanentFailure && /already terminated/.test(e.message));
  assert.equal((await ledger.get(keyFor()))?.status, 'FAILED');
});

test('provider errors surface with the right class and leave the ledger retryable (or failed) as designed', async () => {
  const cases: Array<[string, number, string, string]> = [
    ['RequestLimitExceeded', 503, 'retryable', 'throttled'],
    ['InsufficientInstanceCapacity', 500, 'retryable', 'ambiguous'],
    ['InstanceLimitExceeded', 400, 'permanent', 'auth'],
    ['InvalidParameterValue', 400, 'permanent', 'permanent'],
  ];
  for (const [name, status, kind, errorClass] of cases) {
    const api = new FakeEc2Api(); const ledger = new MemoryLedgerStore();
    api.failNext = { error: awsError(name, status) };
    await assert.rejects(runIdempotent(ec2RunInstanceAction(api), P, id, { ledger }), (e: unknown) =>
      kind === 'retryable' ? e instanceof RetryableFailure && e.errorClass === errorClass
        : e instanceof PermanentFailure && e.errorClass === errorClass, name);
    assert.equal((await ledger.get(keyFor()))?.status, errorClass === 'permanent' ? 'FAILED' : 'UNKNOWN', name);
  }
});

test('cost guard and parameter validation reject BEFORE any AWS call', async () => {
  const api = new FakeEc2Api(); const ledger = new MemoryLedgerStore();
  const act = ec2RunInstanceAction(api, { allowedInstanceTypes: ['t3.nano', 't3.micro'] });
  for (const bad of [{ ...P, instanceType: 'p5.48xlarge' }, { ...P, imageId: 'not-an-ami' }, { ...P, instanceType: 't3 nano; rm -rf' }]) {
    await assert.rejects(runIdempotent(act, bad, id, { ledger }), PermanentFailure, JSON.stringify(bad));
  }
  assert.deepEqual(api.calls, []);
  await runIdempotent(act, { ...P, instanceType: 't3.micro' }, id, { ledger });
  assert.equal(api.instances.length, 1);
});

test('concurrent duplicates launch exactly one instance', async () => {
  const api = new FakeEc2Api(); const ledger = new MemoryLedgerStore();
  const act = ec2RunInstanceAction(api);
  const slow = { ...act, execute: async (p: Ec2Params, c: Parameters<typeof act.execute>[1]) => { await new Promise(r => setTimeout(r, 30)); return act.execute(p, c); } };
  const [a, b] = await Promise.allSettled([runIdempotent(slow, P, id, { ledger }), runIdempotent(slow, P, id, { ledger })]);
  assert.equal([a, b].filter(x => x.status === 'fulfilled').length, 1);
  assert.ok([a, b].some(x => x.status === 'rejected' && x.reason instanceof InFlightError));
  assert.equal(api.instances.length, 1);
});

// ---- the reconciler against EC2 inventory: where orphan CHARGES are stopped -------------------------------------------
test('reconciler terminates orphaned instances, keeps live ones, and never touches terminated ones', async () => {
  const api = new FakeEc2Api(); const ledger = new MemoryLedgerStore();
  const act = ec2RunInstanceAction(api);
  const begin = (key: string, runId = 'live') => ledger.begin({ key, tenantId: 't', runId, action: act.name, provider: 'aws', leaseMs: 60_000 });

  const keep = api.seed('keep');      await begin('keep');   await ledger.succeed('keep', 1, keep);
  const failed = api.seed('failed');  await begin('failed'); await ledger.fail('failed', 1, 'boom');
  const orphan = api.seed('orphan');                                           // no ledger row at all
  const dead = api.seed('deadrun');   await begin('deadrun', 'dead'); await ledger.succeed('deadrun', 1, dead);
  api.seed('already-gone', 'terminated');

  const rep = await reconcile({ ledger, actions: new Map([[act.name, act]]), stuckMs: 1000, isRunDead: async r => r === 'dead' });
  assert.deepEqual(rep.orphansDeleted.sort(), ['deadrun', 'failed', 'orphan']);
  assert.deepEqual(api.live(), ['keep']);
  assert.equal((await ledger.get('failed'))?.status, 'COMPENSATED');
  assert.equal(api.calls.filter(c => c.op === 'terminate').length, 3);        // the already-terminated one was never touched
  void failed; void orphan;
});

test('compensation is idempotent: terminating an unknown instance is not an error', async () => {
  const api = new FakeEc2Api();
  const act = ec2RunInstanceAction(api);
  await act.compensate!({ instanceId: 'i-doesnotexist', state: 'running', token: 'x' } satisfies Ec2Instance, new AbortController().signal);
  assert.equal(api.calls.at(-1)!.op, 'terminate');
});
