import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, idempotencyKey, NonCanonicalError } from '../src/jobs/idempotency.ts';
import { backoffMs, delayMs } from '../src/jobs/backoff.ts';
import { classifyError, ProviderHttpError, PermanentFailure, RetryableFailure, InFlightError, LeaseLost } from '../src/jobs/errors.ts';
import { MemoryLedgerStore } from '../src/jobs/ledger.ts';
import { runIdempotent, assertAction } from '../src/jobs/runner.ts';
import type { ExternalAction, ActionContext } from '../src/jobs/runner.ts';
import { reconcile } from '../src/jobs/reconciler.ts';
import { triage } from '../src/jobs/dlq.ts';
import type { DeadLetter } from '../src/jobs/dlq.ts';
import { CircuitBreaker } from '../src/jobs/breaker.ts';

// ---- idempotency keys --------------------------------------------------------------------
test('canonicalJson: key order independent; rejects values JSON.stringify would mangle', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } }), '{"a":{"c":"x","d":[1,2]},"b":1}');
  assert.equal(canonicalJson({ n: -0 }), '{"n":0}');
  for (const bad of [{ a: undefined }, { a: NaN }, { a: new Date() }, { a: new Map() }, { a: () => 1 }, { a: 1n }]) {
    assert.throws(() => canonicalJson(bad), NonCanonicalError);
  }
});

test('idempotencyKey: stable, field-sensitive, no concatenation ambiguity', () => {
  const base = { tenantId: 't', runId: 'r', stepId: '0:5', action: 'ec2.run', params: { type: 'm5.large', n: 1 } };
  const k = idempotencyKey(base);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(idempotencyKey({ ...base, params: { n: 1, type: 'm5.large' } }), k);
  for (const change of [{ tenantId: 'u' }, { runId: 's' }, { stepId: '0:6' }, { action: 'ec2.stop' }, { params: { type: 'm5.large', n: 2 } }]) {
    assert.notEqual(idempotencyKey({ ...base, ...change }), k);
  }
  assert.notEqual(
    idempotencyKey({ ...base, tenantId: 'a', runId: 'bc' }),
    idempotencyKey({ ...base, tenantId: 'ab', runId: 'c' }));
});

// ---- backoff -----------------------------------------------------------------------------
test('backoff: full jitter stays within [0, min(cap, base*2^(n-1)))', () => {
  const o = { baseMs: 100, capMs: 1000 };
  assert.equal(backoffMs(1, { ...o, rng: () => 0 }), 0);
  assert.equal(backoffMs(1, { ...o, rng: () => 0.999 }), 99);
  assert.equal(backoffMs(50, { ...o, rng: () => 0.999 }), 999);
  for (let n = 1; n <= 12; n++) {
    const bound = Math.min(1000, 100 * 2 ** (n - 1));
    for (let i = 0; i < 200; i++) { const v = backoffMs(n, o); assert.ok(v >= 0 && v < bound); }
  }
});

test('delayMs: honors Retry-After as a floor, caps hostile values', () => {
  const o = { baseMs: 100, capMs: 1000, maxRetryAfterMs: 5000, rng: () => 0 };
  assert.equal(delayMs(1, o, 2000), 2000);
  assert.equal(delayMs(1, o, 3_600_000), 5000);
  assert.equal(delayMs(1, o, undefined), 0);
});

// ---- classification ----------------------------------------------------------------------
test('classifyError', () => {
  const c = (e: unknown) => classifyError(e).cls;
  assert.equal(c(new ProviderHttpError(400, 'bad')), 'permanent');
  assert.equal(c(new ProviderHttpError(404, 'nf')), 'permanent');
  assert.equal(c(new ProviderHttpError(401, 'x')), 'auth');
  assert.equal(c(new ProviderHttpError(403, 'x')), 'auth');
  assert.equal(c(new ProviderHttpError(409, 'in progress')), 'transient');
  assert.equal(c(new ProviderHttpError(503, 'x')), 'ambiguous');
  assert.equal(c(new ProviderHttpError(408, 'x')), 'ambiguous');
  assert.deepEqual(classifyError(new ProviderHttpError(429, 'slow', 1500)), { cls: 'throttled', retryAfterMs: 1500 });
  assert.equal(c(new DOMException('t', 'TimeoutError')), 'ambiguous');
  assert.equal(c(Object.assign(new Error('x'), { code: 'ECONNRESET' })), 'ambiguous');
  assert.equal(c(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), 'transient');
  assert.equal(c(new TypeError('fetch failed')), 'ambiguous');
  assert.equal(c(Object.assign(new TypeError('x'), { cause: { code: 'ECONNRESET' } })), 'ambiguous');
  assert.equal(c(new TypeError('cannot read properties of undefined')), 'permanent');
  assert.equal(c(new LeaseLost('x')), 'transient');
  assert.equal(c(new Error('???')), 'transient');
});

// ---- fake cloud --------------------------------------------------------------------------
interface Res { id: string; token: string }
class FakeCloud {
  all: Res[] = [];
  byToken = new Map<string, Res>();
  createCalls = 0;
  nextError: Error | null = null;
  errorAfterCreate = false;
  delayMs = 0;
  deleted: string[] = [];
}

function makeAction(cloud: FakeCloud, native: boolean, withLookup = true): ExternalAction<{ n: number }, Res> {
  const a: ExternalAction<{ n: number }, Res> = {
    name: 'vm.create', provider: 'fakecloud', nativeIdempotency: native,
    async execute(_p, ctx: ActionContext) {
      cloud.createCalls++;
      if (cloud.delayMs) await new Promise(r => setTimeout(r, cloud.delayMs));
      if (native) { const ex = cloud.byToken.get(ctx.token); if (ex) return ex; }
      const fail = cloud.nextError; cloud.nextError = null;
      if (fail && !cloud.errorAfterCreate) throw fail;
      const r: Res = { id: `i-${cloud.all.length + 1}`, token: ctx.token };
      cloud.all.push(r); cloud.byToken.set(ctx.token, r);
      if (fail) throw fail;                         // server executed, client saw an error
      return r;
    },
    async compensate(r) { cloud.all = cloud.all.filter(x => x.id !== r.id); cloud.deleted.push(r.id); },
    async *inventory() { for (const r of [...cloud.all]) yield { token: r.token, resource: r }; },
  };
  if (withLookup) a.lookup = async token => cloud.all.find(r => r.token === token) ?? null;
  return a;
}

const id = { tenantId: 't1', runId: 'r1', stepId: '0:1' };
const P = { n: 1 };

class FlakyLedger extends MemoryLedgerStore {
  failSucceed = 0;
  failMarkUnknown = 0;
  override async succeed(k: string, a: number, r: unknown) {
    if (this.failSucceed-- > 0) throw new Error('db down');
    return super.succeed(k, a, r);
  }
  override async markUnknown(k: string, a: number, e: string) {
    if (this.failMarkUnknown-- > 0) throw new Error('db down');
    return super.markUnknown(k, a, e);
  }
}

test('assertAction: non-idempotent provider must implement lookup', () => {
  assert.throws(() => assertAction(makeAction(new FakeCloud(), false, false)));
  assertAction(makeAction(new FakeCloud(), true, false));
});

test('happy path, then replay is deduplicated; param key order does not matter', async () => {
  const cloud = new FakeCloud(); const ledger = new MemoryLedgerStore();
  const act = makeAction(cloud, false);
  const a = await runIdempotent(act, { n: 1, extra: 'x' } as any, id, { ledger });
  const b = await runIdempotent(act, { extra: 'x', n: 1 } as any, id, { ledger });
  assert.equal(a.deduped, false); assert.equal(b.deduped, true);
  assert.equal(cloud.createCalls, 1);
  assert.deepEqual(b.result, a.result);
});

test('concurrent duplicates: exactly one executes, the other sees InFlight', async () => {
  const cloud = new FakeCloud(); cloud.delayMs = 40; const ledger = new MemoryLedgerStore();
  const act = makeAction(cloud, false);
  const [x, y] = await Promise.allSettled([runIdempotent(act, P, id, { ledger }), runIdempotent(act, P, id, { ledger })]);
  const outcomes = [x, y];
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  const rej = outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rej.reason instanceof InFlightError);
  assert.equal(cloud.createCalls, 1);
});

test('crash after external success (native token): retry cannot double-provision', async () => {
  const cloud = new FakeCloud(); const ledger = new FlakyLedger(); ledger.failSucceed = 1;
  const act = makeAction(cloud, true, false);
  await assert.rejects(runIdempotent(act, P, id, { ledger }), (e: unknown) => e instanceof RetryableFailure && e.errorClass === 'ambiguous');
  const out = await runIdempotent(act, P, id, { ledger });
  assert.equal(cloud.createCalls, 2);          // provider was called twice...
  assert.equal(cloud.all.length, 1);           // ...but the token made it create one resource
  assert.equal(out.result.id, 'i-1');
});

test('crash after external success (no native idempotency): lookup adopts instead of re-creating', async () => {
  const cloud = new FakeCloud(); const ledger = new FlakyLedger(); ledger.failSucceed = 1;
  const act = makeAction(cloud, false);
  await assert.rejects(runIdempotent(act, P, id, { ledger }), RetryableFailure);
  const out = await runIdempotent(act, P, id, { ledger });
  assert.equal(cloud.createCalls, 1);
  assert.equal(cloud.all.length, 1);
  assert.equal(out.deduped, true);
});

test('database fully down during the crash: lease expiry (not luck) lets the next attempt resolve it', async () => {
  let t = 1_000_000; const events: string[] = [];
  const cloud = new FakeCloud(); const ledger = new FlakyLedger(() => t); ledger.failSucceed = 1; ledger.failMarkUnknown = 1;
  const act = makeAction(cloud, false);
  const deps = { ledger, leaseMs: 30_000, onEvent: (e: { type: string }) => events.push(e.type) };
  await assert.rejects(runIdempotent(act, P, id, deps), RetryableFailure);
  await assert.rejects(runIdempotent(act, P, id, deps), InFlightError);     // lease still live: no double execution
  t += 31_000;
  const out = await runIdempotent(act, P, id, deps);
  assert.equal(out.deduped, true);
  assert.equal(cloud.all.length, 1);
  assert.ok(events.includes('resume') && events.includes('lookup_hit'));
});

test('ambiguous timeout (server executed, client timed out) never produces a second resource', async () => {
  const cloud = new FakeCloud(); const ledger = new MemoryLedgerStore();
  cloud.nextError = new DOMException('timed out', 'TimeoutError'); cloud.errorAfterCreate = true;
  const act = makeAction(cloud, false);
  await assert.rejects(runIdempotent(act, P, id, { ledger }), (e: unknown) => e instanceof RetryableFailure && e.errorClass === 'ambiguous');
  assert.equal(cloud.all.length, 1);
  const out = await runIdempotent(act, P, id, { ledger });
  assert.equal(cloud.createCalls, 1);
  assert.equal(out.deduped, true);
});

test('permanent failure is recorded and never re-executed', async () => {
  const cloud = new FakeCloud(); const ledger = new MemoryLedgerStore();
  cloud.nextError = new ProviderHttpError(400, 'invalid instance type');
  const act = makeAction(cloud, false);
  await assert.rejects(runIdempotent(act, P, id, { ledger }), (e: unknown) => e instanceof PermanentFailure && e.errorClass === 'permanent');
  await assert.rejects(runIdempotent(act, P, id, { ledger }), PermanentFailure);
  assert.equal(cloud.createCalls, 1);
  assert.equal((await ledger.get([...ledger.rows.keys()][0]!))?.status, 'FAILED');
});

test('auth failure: job-permanent but ledger-retryable, so a redrive after the fix works', async () => {
  const cloud = new FakeCloud(); const ledger = new MemoryLedgerStore();
  cloud.nextError = new ProviderHttpError(403, 'AccessDenied');
  const act = makeAction(cloud, false);
  await assert.rejects(runIdempotent(act, P, id, { ledger }), (e: unknown) => e instanceof PermanentFailure && e.errorClass === 'auth');
  assert.equal([...ledger.rows.values()][0]!.status, 'UNKNOWN');
  const out = await runIdempotent(act, P, id, { ledger });
  assert.equal(out.deduped, false);
  assert.equal(cloud.all.length, 1);
});

test('throttling surfaces Retry-After to the scheduler', async () => {
  const cloud = new FakeCloud(); const ledger = new MemoryLedgerStore();
  cloud.nextError = new ProviderHttpError(429, 'slow down', 2000);
  await assert.rejects(runIdempotent(makeAction(cloud, false), P, id, { ledger }),
    (e: unknown) => e instanceof RetryableFailure && e.errorClass === 'throttled' && e.retryAfterMs === 2000);
});

test('lost lease aborts the in-flight call', async () => {
  class Lose extends MemoryLedgerStore { override async extendLease() { return false; } }
  const ledger = new Lose();
  const act: ExternalAction<unknown, Res> = {
    name: 'slow', provider: 'p', nativeIdempotency: true,
    execute: (_p, ctx) => new Promise((_res, rej) => ctx.signal.addEventListener('abort', () => rej(ctx.signal.reason))),
  };
  await assert.rejects(runIdempotent(act, P, id, { ledger, leaseMs: 30 }),
    (e: unknown) => e instanceof RetryableFailure && e.errorClass === 'transient');
});

test('per-attempt timeout aborts the call and is classified ambiguous', async () => {
  const ledger = new MemoryLedgerStore();
  const act: ExternalAction<unknown, Res> = {
    name: 'hang', provider: 'p', nativeIdempotency: true,
    execute: (_p, ctx) => new Promise((_res, rej) => ctx.signal.addEventListener('abort', () => rej(ctx.signal.reason))),
  };
  await assert.rejects(runIdempotent(act, P, id, { ledger, attemptTimeoutMs: 30 }),
    (e: unknown) => e instanceof RetryableFailure && e.errorClass === 'ambiguous');
});

// ---- reconciler --------------------------------------------------------------------------
test('reconciler: adopts crashed-but-created resources, reaps orphans, spares live ones', async () => {
  let t = 0; const ledger = new MemoryLedgerStore(() => t); const cloud = new FakeCloud();
  const act = makeAction(cloud, false);
  const mk = (token: string, runId = 'live') => { const r = { id: `i-${token}`, token }; cloud.all.push(r); return r; };
  const begin = (key: string, runId = 'live') => ledger.begin({ key, tenantId: 't', runId, action: 'vm.create', provider: 'fakecloud', leaseMs: 1000 });

  mk('K1'); await begin('K1');                                                         // crashed mid-flight, resource exists
  mk('K2'); await begin('K2'); await ledger.succeed('K2', 1, { id: 'i-K2' });          // healthy
  mk('K3');                                                                            // resource with no ledger row
  mk('K4'); await begin('K4'); await ledger.fail('K4', 1, 'boom');                     // failed but resource leaked
  mk('K5'); await begin('K5', 'dead'); await ledger.succeed('K5', 1, { id: 'i-K5' });  // run is dead
  t += 5000;                                                                           // K1's lease expires

  const rep = await reconcile({
    ledger, actions: new Map([['vm.create', act]]), stuckMs: 1000,
    isRunDead: async runId => runId === 'dead',
  });
  assert.deepEqual(rep.adopted, ['K1']);
  assert.deepEqual(rep.orphansDeleted.sort(), ['K3', 'K4', 'K5']);
  assert.deepEqual(cloud.all.map(r => r.token).sort(), ['K1', 'K2']);
  assert.equal((await ledger.get('K4'))?.status, 'COMPENSATED');
  assert.equal((await ledger.get('K1'))?.status, 'SUCCEEDED');
  assert.equal(rep.capped, false);
});

test('reconciler: blast-radius cap stops a runaway reap', async () => {
  const ledger = new MemoryLedgerStore(); const cloud = new FakeCloud();
  for (let i = 0; i < 6; i++) cloud.all.push({ id: `i-${i}`, token: `orphan${i}` });
  const rep = await reconcile({
    ledger, actions: new Map([['vm.create', makeAction(cloud, false)]]), stuckMs: 1000,
    isRunDead: async () => true, maxReaps: 2,
  });
  assert.equal(rep.orphansDeleted.length, 2);
  assert.equal(rep.capped, true);
  assert.equal(cloud.all.length, 4);
});

// ---- DLQ triage --------------------------------------------------------------------------
const dl = (o: Partial<DeadLetter>): DeadLetter => ({
  key: 'k', jobType: 'action', tenantId: 't', runId: 'r', action: 'vm.create', provider: 'aws',
  errorClass: 'transient', attempts: 6, redrives: 0, lastError: 'x', firstFailedAt: 0, ...o,
});
const ctx = (breakerMs = 0) => ({ breakerRetryInMs: () => breakerMs, maxRedrives: 3, backoff: { baseMs: 1000, capMs: 60_000, rng: () => 0 } });

test('triage decision table', () => {
  assert.equal(triage(dl({ errorClass: 'permanent' }), ctx()).kind, 'quarantine');
  assert.deepEqual(triage(dl({ errorClass: 'auth' }), ctx()), { kind: 'escalate', reason: 'credentials or permissions rejected', pageHuman: true });
  assert.equal(triage(dl({ errorClass: 'budget', jobType: 'agent' }), ctx()).kind, 'escalate');
  assert.equal(triage(dl({ redrives: 3 }), ctx()).kind, 'escalate');
  const amb = triage(dl({ errorClass: 'ambiguous' }), ctx());
  assert.equal(amb.kind === 'redrive' && amb.reconcileFirst, true);
  const thr = triage(dl({ errorClass: 'throttled' }), ctx());
  assert.equal(thr.kind === 'redrive' && thr.reconcileFirst, false);
  const waited = triage(dl({ errorClass: 'transient' }), ctx(120_000));
  assert.equal(waited.kind === 'redrive' && waited.delayMs, 120_000);       // never redrive into an open breaker
});

// ---- circuit breaker ---------------------------------------------------------------------
test('circuit breaker: opens, waits, allows one probe, closes or reopens', () => {
  let t = 0; const b = new CircuitBreaker({ failureThreshold: 3, openMs: 1000, now: () => t });
  b.failure(); b.failure(); assert.equal(b.canPass(), true);
  b.failure(); assert.equal(b.status(), 'open'); assert.equal(b.canPass(), false);
  assert.equal(b.retryInMs(), 1000);
  t += 1000; assert.equal(b.status(), 'half_open');
  assert.equal(b.canPass(), true); assert.equal(b.canPass(), false);       // exactly one probe
  b.failure(); assert.equal(b.status(), 'open');                           // probe failed: reopen
  t += 1000; assert.equal(b.canPass(), true); b.success();
  assert.equal(b.status(), 'closed'); assert.equal(b.canPass(), true);
});
