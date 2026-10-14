import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { ENABLED, adminPool, appPool, itest, redisUrl, sleep, uuid } from './_helpers.ts';
import { DDL, EventStore, FencedOut, LeaseManager, SeqConflict, partitionDdl } from '../../src/store.ts';
import type { EventRow, Lease } from '../../src/store.ts';

let admin: Pool; let app: Pool; let redis: Redis; let store: EventStore;

if (ENABLED) {
  before(async () => {
    admin = adminPool();
    await admin.query('DROP TABLE IF EXISTS run_events CASCADE');
    await admin.query(DDL);
    await admin.query(partitionDdl(4));
    app = await appPool(admin);
    await admin.query('GRANT SELECT, INSERT ON run_events TO nexus_app');
    store = new EventStore(app);
    redis = new Redis(redisUrl());
    await redis.flushall();
  });
  after(async () => { await redis?.quit(); await app?.end(); await admin?.end(); });
}

const row = (t: string, r: string, seq: number, fence: number): EventRow =>
  ({ tenantId: t, runId: r, branchId: 0, seq, fence, from: 'CODE', to: 'COMPILE', artifact: {} });

itest('zombie writer: paused past its lease, it wakes up and is rejected by Postgres', async () => {
  const leases = new LeaseManager(redis, 250);
  const t = uuid(), r = uuid();

  const a = await leases.acquire(t, r, 0, await store.maxFence(t, r)) as Lease;
  await store.append(row(t, r, 1, a.fence));
  await sleep(400);                                          // A stalls (GC pause, partition): its lease expires

  const b = await leases.acquire(t, r, 0, await store.maxFence(t, r)) as Lease;
  assert.ok(b.fence > a.fence);
  await store.append(row(t, r, 2, b.fence));

  // A wakes up still believing it owns the run.
  await assert.rejects(store.append(row(t, r, 3, a.fence)), (e) => e instanceof FencedOut);
  await assert.rejects(store.append(row(t, r, 2, a.fence)), (e) => e instanceof FencedOut || e instanceof SeqConflict);
  await store.append(row(t, r, 3, b.fence));

  const { rows } = await admin.query('SELECT seq::int AS seq, fence::int AS fence FROM run_events WHERE run_id = $1 ORDER BY seq', [r]);
  assert.deepEqual(rows, [{ seq: 1, fence: a.fence }, { seq: 2, fence: b.fence }, { seq: 3, fence: b.fence }]);
});

itest('Redis loses its counter: without the floor the new owner is locked out; with it, liveness is restored', async () => {
  const leases = new LeaseManager(redis, 5_000);
  const t = uuid(), r = uuid();
  await store.append(row(t, r, 1, 5));                       // history written by an owner with fence 5

  await redis.flushall();                                    // failover / flush: the counter is gone
  const naive = await leases.acquire(t, r) as Lease;         // no floor: fence restarts at 1
  assert.equal(naive.fence, 1);
  await assert.rejects(store.append(row(t, r, 2, naive.fence)), (e) => e instanceof FencedOut);   // safe, but stuck
  await leases.release(naive);

  const seeded = await leases.acquire(t, r, 0, await store.maxFence(t, r)) as Lease;
  assert.equal(seeded.fence, 6);
  await store.append(row(t, r, 2, seeded.fence));
});

itest('lease holder and fence together: concurrent takeover attempts never produce two writers', async () => {
  const leases = new LeaseManager(redis, 5_000);
  const t = uuid(), r = uuid();
  const owners = await Promise.all(Array.from({ length: 20 }, async () => leases.acquire(t, r, 0, await store.maxFence(t, r))));
  const winners = owners.filter((x): x is Lease => x !== null);
  assert.equal(winners.length, 1);
  await store.append(row(t, r, 1, winners[0]!.fence));
});
