import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { ENABLED, adminPool, itest, sleep, uuid } from './_helpers.ts';
import { LEDGER_DDL, PgLedgerStore } from '../../src/jobs/pgLedger.ts';
import { MemoryLedgerStore } from '../../src/jobs/ledger.ts';
import type { BeginInput, LedgerRow } from '../../src/jobs/ledger.ts';

let pool: Pool;
let pgl: PgLedgerStore;

if (ENABLED) {
  before(async () => {
    pool = adminPool();
    await pool.query('DROP TABLE IF EXISTS action_ledger CASCADE');
    await pool.query(LEDGER_DDL);
    pgl = new PgLedgerStore(pool);
  });
  after(async () => { await pool?.end(); });
}

const input = (key: string, leaseMs = 60_000): BeginInput =>
  ({ key, tenantId: uuid(), runId: uuid(), action: 'vm.create', provider: 'fake', leaseMs });

itest('begin is atomic: 25 concurrent callers, exactly one starts', async () => {
  const i = input(`atomic-${uuid()}`);
  const results = await Promise.all(Array.from({ length: 25 }, () => pgl.begin(i)));
  assert.equal(results.filter(r => r.kind === 'started').length, 1);
  assert.equal(results.filter(r => r.kind === 'in_flight').length, 24);
});

itest('lease expiry uses the database clock; takeover fences out the old attempt', async () => {
  const i = input(`lease-${uuid()}`, 300);
  assert.deepEqual(await pgl.begin(i), { kind: 'started', attempt: 1 });
  assert.deepEqual(await pgl.begin(i), { kind: 'in_flight' });
  await sleep(500);
  assert.deepEqual(await pgl.begin(i), { kind: 'resumed', attempt: 2 });
  assert.equal(await pgl.succeed(i.key, 1, { stale: true }), false);       // attempt 1 is fenced out
  assert.equal(await pgl.extendLease(i.key, 1, 1000), false);
  assert.equal(await pgl.succeed(i.key, 2, { id: 'i-1', nested: { n: [1, 2] } }), true);
  assert.deepEqual(await pgl.begin(i), { kind: 'already_succeeded', result: { id: 'i-1', nested: { n: [1, 2] } } });
  const row = await pgl.get(i.key);
  assert.equal(row?.status, 'SUCCEEDED');
  assert.equal(row?.leaseExpiresAt, null);
});

itest('listStuck finds expired INTENT rows and UNKNOWN rows', async () => {
  const stuck = input(`stuck-${uuid()}`, 100);
  const unknown = input(`unknown-${uuid()}`);
  const live = input(`live-${uuid()}`);
  await pgl.begin(stuck); await pgl.begin(unknown); await pgl.begin(live);
  await pgl.markUnknown(unknown.key, 1, 'timeout');
  await sleep(250);
  const keys = (await pgl.listStuck(0)).map(r => r.key);
  assert.ok(keys.includes(stuck.key) && keys.includes(unknown.key));
  assert.ok(!keys.includes(live.key));
});

// ---- model-based differential test: the SQL must behave exactly like the in-memory reference --------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
const proj = (r: LedgerRow | null) => r && ({ status: r.status, attempt: r.attempt, result: r.result, error: r.error, leased: r.leaseExpiresAt !== null });

itest('PgLedgerStore matches MemoryLedgerStore over 5 x 250 random operations', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = rng(seed);
    const clock = 1_000_000;
    const mem = new MemoryLedgerStore(() => clock);
    const tenant = uuid(), run = uuid();
    const keys = [0, 1, 2].map(n => `diff-${seed}-${uuid()}-${n}`);
    const owned = new Map<string, number>();

    for (let step = 0; step < 250; step++) {
      const key = keys[Math.floor(r() * keys.length)]!;
      const roll = r();
      const attempt = r() < 0.7 ? (owned.get(key) ?? 1) : 1 + Math.floor(r() * 3);   // often the owner, sometimes stale
      const ctx = `seed ${seed} step ${step} key#${keys.indexOf(key)} roll ${roll.toFixed(2)}`;

      if (roll < 0.30) {
        const b: BeginInput = { key, tenantId: tenant, runId: run, action: 'a', provider: 'p', leaseMs: 60_000 };
        const m = await mem.begin(b);
        const p = await pgl.begin(b);
        assert.deepEqual(p, m, `begin: ${ctx}`);
        if (m.kind === 'started' || m.kind === 'resumed') owned.set(key, m.attempt);
      } else if (roll < 0.45) {
        assert.equal(await pgl.succeed(key, attempt, { step }), await mem.succeed(key, attempt, { step }), `succeed: ${ctx}`);
      } else if (roll < 0.53) {
        assert.equal(await pgl.fail(key, attempt, `e${step}`), await mem.fail(key, attempt, `e${step}`), `fail: ${ctx}`);
      } else if (roll < 0.65) {
        assert.equal(await pgl.markUnknown(key, attempt, `u${step}`), await mem.markUnknown(key, attempt, `u${step}`), `markUnknown: ${ctx}`);
      } else if (roll < 0.73) {
        assert.equal(await pgl.extendLease(key, attempt, 60_000), await mem.extendLease(key, attempt, 60_000), `extendLease: ${ctx}`);
      } else if (roll < 0.77) {
        assert.equal(await pgl.markCompensated(key), await mem.markCompensated(key), `markCompensated: ${ctx}`);
      } else {
        // expire the lease in both worlds (the SQL cannot be given a fake clock)
        const row = mem.rows.get(key);
        if (row && row.leaseExpiresAt !== null) row.leaseExpiresAt = clock - 1;
        await pool.query(`UPDATE action_ledger SET lease_expires_at = now() - interval '1 second' WHERE key = $1 AND lease_expires_at IS NOT NULL`, [key]);
      }
      assert.deepEqual(proj(await pgl.get(key)), proj(await mem.get(key)), `state after: ${ctx}`);
    }

    await sleep(10);
    const sortKeys = (rows: LedgerRow[]) => rows.map(x => x.key).filter(k => keys.includes(k)).sort();
    assert.deepEqual(sortKeys(await pgl.listStuck(0)), sortKeys(await mem.listStuck(0)), `listStuck, seed ${seed}`);
  }
});
