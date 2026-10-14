import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { ENABLED, itest, redisUrl, sleep, uuid } from './_helpers.ts';
import { LeaseManager } from '../../src/store.ts';
import type { Lease } from '../../src/store.ts';

let redis: Redis;

if (ENABLED) {
  before(async () => { redis = new Redis(redisUrl()); await redis.flushall(); });
  after(async () => { await redis?.quit(); });
}

itest('a held lease cannot be acquired; fences increase monotonically across owners', async () => {
  const leases = new LeaseManager(redis, 5_000);
  const t = uuid(), r = uuid();
  const a = await leases.acquire(t, r);
  assert.ok(a);
  assert.equal(await leases.acquire(t, r), null);
  await leases.release(a);
  const b = await leases.acquire(t, r);
  assert.ok(b && b.fence === a.fence + 1);
});

itest('concurrent acquirers: exactly one wins', async () => {
  const leases = new LeaseManager(redis, 5_000);
  const t = uuid(), r = uuid();
  const got = await Promise.all(Array.from({ length: 25 }, () => leases.acquire(t, r)));
  assert.equal(got.filter(Boolean).length, 1);
});

itest('only the owner can renew or release; a stale owner cannot disturb the new one', async () => {
  const leases = new LeaseManager(redis, 250);
  const t = uuid(), r = uuid();
  const a = await leases.acquire(t, r) as Lease;
  assert.equal(await leases.renew({ ...a, token: 'not-the-owner' }), false);
  assert.equal(await leases.renew(a), true);
  await sleep(400);                                         // a's lease expires
  const b = await leases.acquire(t, r) as Lease;
  assert.ok(b && b.fence > a.fence);
  assert.equal(await leases.renew(a), false);               // zombie cannot renew
  await leases.release(a);                                  // ...nor release the new owner's lease
  assert.equal(await leases.acquire(t, r), null);
  assert.equal(await leases.renew(b), true);
});

itest('fence floor re-seeds a lost Redis counter', async () => {
  const leases = new LeaseManager(redis, 5_000);
  const t = uuid(), r = uuid();
  const a = await leases.acquire(t, r, 0, 41) as Lease;     // Postgres has seen fence 41
  assert.equal(a.fence, 42);
  await leases.release(a);
  const b = await leases.acquire(t, r, 0, 10) as Lease;     // a lower floor never lowers the counter
  assert.equal(b.fence, 43);
});

itest('hot-state CAS only moves forward', async () => {
  const leases = new LeaseManager(redis, 5_000);
  const t = uuid(), r = uuid();
  const key = `t:{${t}}:run:{${r}}:b0:hot`;
  assert.equal(await leases.putHot(t, r, 0, 5, 'five'), true);
  assert.equal(await leases.putHot(t, r, 0, 3, 'three'), false);
  assert.equal(await leases.putHot(t, r, 0, 5, 'again'), false);
  assert.equal(await leases.putHot(t, r, 0, 6, 'six'), true);
  assert.deepEqual(await redis.hgetall(key), { v: '6', state: 'six' });
});
