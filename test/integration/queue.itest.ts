import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import type { Worker } from 'bullmq';
import type { Pool } from 'pg';
import { ENABLED, adminPool, itest, redisOpts, redisUrl, sleep, uuid, waitFor } from './_helpers.ts';
import { LEDGER_DDL, PgLedgerStore } from '../../src/jobs/pgLedger.ts';
import { RETRY_BACKOFF, createTopology, enqueue, redrive, startInfraWorker } from '../../src/jobs/queues.ts';
import type { JobPayload, Topology } from '../../src/jobs/queues.ts';
import { BackpressureError, ProviderHttpError } from '../../src/jobs/errors.ts';
import { BreakerRegistry } from '../../src/jobs/breaker.ts';
import type { ExternalAction } from '../../src/jobs/runner.ts';

interface Res { id: string; token: string }
class Cloud {
  resources: Res[] = [];
  calls = 0;
  failures: Array<{ err: Error; afterCreate: boolean }> = [];
}
const cloud = new Cloud();
const action: ExternalAction<{ name: string }, Res> = {
  name: 'vm.create', provider: 'fakecloud', nativeIdempotency: false,
  async execute(_p, ctx) {
    cloud.calls++;
    const f = cloud.failures.shift();
    if (f && !f.afterCreate) throw f.err;
    const r: Res = { id: `i-${cloud.resources.length + 1}`, token: ctx.token };
    cloud.resources.push(r);
    if (f) throw f.err;                                    // the server executed, the client saw an error
    return r;
  },
  async lookup(token) { return cloud.resources.find(r => r.token === token) ?? null; },
};

let admin: Pool; let ledger: PgLedgerStore; let redis: Redis; let topo: Topology; let worker: Worker<JobPayload>;
const originalBackoff = { ...RETRY_BACKOFF };

if (ENABLED) {
  before(async () => {
    admin = adminPool();
    await admin.query('DROP TABLE IF EXISTS action_ledger CASCADE');
    await admin.query(LEDGER_DDL);
    ledger = new PgLedgerStore(admin);
    redis = new Redis(redisUrl());
    await redis.flushall();
    Object.assign(RETRY_BACKOFF, { baseMs: 5, capMs: 50 });          // keep BullMQ retries fast
    topo = createTopology(redisOpts());
    worker = startInfraWorker(redisOpts(), topo, new Map([[action.name, action as ExternalAction<any, any>]]),
      { ledger, leaseMs: 5_000, attemptTimeoutMs: 5_000 }, new BreakerRegistry({ failureThreshold: 1000, openMs: 1000 }),
      { concurrency: 4, maxRedrives: 3, dlqBackoff: { baseMs: 5, capMs: 20, rng: () => 0.5 } });
    await worker.waitUntilReady();
  });
  after(async () => {
    Object.assign(RETRY_BACKOFF, originalBackoff);
    await worker?.close();
    await topo?.close();
    await redis?.quit();
    await admin?.end();
  });
}

const payload = (name: string): JobPayload => ({ tenantId: uuid(), runId: uuid(), stepId: '0:1', action: 'vm.create', params: { name } });
const status = (key: string) => async () => (await ledger.get(key))?.status;
const reset = () => { cloud.resources = []; cloud.calls = 0; cloud.failures = []; };
const findDead = (key: string) => waitFor(async () =>
  (await topo.dlq.getJobs(['waiting', 'delayed', 'completed', 'failed'], 0, 100)).find(j => j.data.dead.key === key), 20_000, `DLQ entry for ${key.slice(0, 8)}`);

itest('a job flows through BullMQ, the Postgres ledger and the provider exactly once', async () => {
  reset();
  const key = await enqueue(topo.infra, payload('happy'));
  await waitFor(async () => (await status(key)()) === 'SUCCEEDED', 15_000, 'ledger SUCCEEDED');
  assert.equal(cloud.resources.length, 1);
  assert.equal(cloud.calls, 1);
  assert.equal((await ledger.get(key))?.attempt, 1);
});

itest('duplicate enqueues collapse to one job and one provider call', async () => {
  reset();
  const p = payload('dup');
  const [k1, k2] = await Promise.all([enqueue(topo.infra, p), enqueue(topo.infra, p)]);
  assert.equal(k1, k2);
  await waitFor(async () => (await status(k1)()) === 'SUCCEEDED');
  assert.equal(await enqueue(topo.infra, p), k1);                    // after completion too
  await sleep(300);
  assert.equal(cloud.calls, 1);
  assert.equal(cloud.resources.length, 1);
});

itest('ambiguous failure (created, then 503): BullMQ retries, the ledger resumes, lookup adopts: one resource', async () => {
  reset();
  cloud.failures = [{ err: new ProviderHttpError(503, 'gateway timeout'), afterCreate: true }];
  const key = await enqueue(topo.infra, payload('ambiguous'));
  await waitFor(async () => (await status(key)()) === 'SUCCEEDED', 20_000, 'recovery');
  assert.equal(cloud.resources.length, 1);
  assert.equal(cloud.calls, 1);                                      // the retry never called the provider again
  assert.equal((await ledger.get(key))?.attempt, 2);                // begin() ran twice: started, then resumed
  const job = await topo.infra.getJob(key);
  assert.equal(await job?.getState(), 'completed');
});

itest('permanent failure: no retries, ledger FAILED, DLQ entry classified permanent and quarantined', async () => {
  reset();
  cloud.failures = [{ err: new ProviderHttpError(400, 'invalid instance type'), afterCreate: false }];
  const key = await enqueue(topo.infra, payload('permanent'));
  const dead = await findDead(key);
  assert.equal(dead.data.dead.errorClass, 'permanent');
  assert.equal(dead.data.decision.kind, 'quarantine');
  assert.equal(dead.data.dead.attempts, 1);
  assert.equal((await ledger.get(key))?.status, 'FAILED');
  assert.equal(cloud.calls, 1);
});

itest('exhausted ambiguous failures reach the DLQ as reconcile-first redrives; a redrive then succeeds with one resource', async () => {
  reset();
  cloud.failures = Array.from({ length: 6 }, () => ({ err: new ProviderHttpError(503, 'unavailable'), afterCreate: false }));
  const key = await enqueue(topo.infra, payload('exhaust'));
  const dead = await findDead(key);
  assert.equal(dead.data.dead.errorClass, 'ambiguous');
  assert.equal(dead.data.dead.attempts, 6);
  assert.equal(dead.data.dead.redrives, 0);
  assert.deepEqual([dead.data.decision.kind, (dead.data.decision as { reconcileFirst?: boolean }).reconcileFirst], ['redrive', true]);
  assert.equal((await ledger.get(key))?.status, 'UNKNOWN');
  assert.equal(cloud.calls, 6);

  await redrive(topo, dead.data);                                    // the provider has recovered (failures exhausted)
  await waitFor(async () => (await status(key)()) === 'SUCCEEDED', 20_000, 'redrive success');
  assert.equal(cloud.resources.length, 1);
  assert.equal(cloud.calls, 7);
});

itest('admission control: a full queue rejects producers instead of buffering without bound', async () => {
  for (let i = 0; i < 5; i++) await enqueue(topo.agent, payload(`bp-${i}`), 5);   // the agent queue has no consumer here
  await assert.rejects(enqueue(topo.agent, payload('bp-over'), 5), (e) => e instanceof BackpressureError);
});
