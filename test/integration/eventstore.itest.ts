import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { ENABLED, adminPool, appPool, itest, uuid } from './_helpers.ts';
import { DDL, EventStore, FencedOut, SeqConflict, partitionDdl } from '../../src/store.ts';
import type { EventRow } from '../../src/store.ts';

let admin: Pool;
let app: Pool;
let store: EventStore;

if (ENABLED) {
  before(async () => {
    admin = adminPool();
    await admin.query('DROP TABLE IF EXISTS run_events CASCADE');
    await admin.query(DDL);
    await admin.query(partitionDdl(4));
    app = await appPool(admin);
    await admin.query('GRANT SELECT, INSERT ON run_events TO nexus_app');   // note: no UPDATE, no DELETE
    store = new EventStore(app);
  });
  after(async () => { await app?.end(); await admin?.end(); });
}

const row = (o: Partial<EventRow> & Pick<EventRow, 'tenantId' | 'runId' | 'seq' | 'fence'>): EventRow =>
  ({ branchId: 0, from: 'CODE', to: 'COMPILE', artifact: { kind: 'patch_applied' }, ...o });

const reject = (e: unknown, cls: new (...a: never[]) => Error) => e instanceof cls;

itest('append round-trips bigint, jsonb and bytea', async () => {
  const t = uuid(), r = uuid();
  const promptSha = Buffer.from('00ff10ab', 'hex');
  await store.append(row({ tenantId: t, runId: r, seq: 3_000_000_000, fence: 4_000_000_000, promptSha, treeRoot: Buffer.from('cafe', 'hex'),
    artifact: { kind: 'compile_result', exitCode: 1, diagnostics: [{ code: 'TS1' }] } }));
  const { rows } = await admin.query('SELECT seq::text, fence::text, artifact, prompt_sha, tree_root, to_state FROM run_events WHERE run_id = $1', [r]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seq, '3000000000');
  assert.equal(rows[0].fence, '4000000000');
  assert.deepEqual(rows[0].artifact, { kind: 'compile_result', exitCode: 1, diagnostics: [{ code: 'TS1' }] });
  assert.ok(Buffer.compare(rows[0].prompt_sha, promptSha) === 0);
  assert.equal(rows[0].to_state, 'COMPILE');
});

itest('a duplicate seq is rejected as SeqConflict, even with a higher fence', async () => {
  const t = uuid(), r = uuid();
  await store.append(row({ tenantId: t, runId: r, seq: 1, fence: 1 }));
  await assert.rejects(store.append(row({ tenantId: t, runId: r, seq: 1, fence: 1 })), (e) => reject(e, SeqConflict));
  await assert.rejects(store.append(row({ tenantId: t, runId: r, seq: 1, fence: 9 })), (e) => reject(e, SeqConflict));
});

itest('a stale fence is rejected once a higher fence has written (zombie writer)', async () => {
  const t = uuid(), r = uuid();
  await store.append(row({ tenantId: t, runId: r, seq: 1, fence: 5 }));
  await assert.rejects(store.append(row({ tenantId: t, runId: r, seq: 2, fence: 3 })), (e) => reject(e, FencedOut));
  await store.append(row({ tenantId: t, runId: r, seq: 2, fence: 5 }));          // same fence: same writer continues
  await store.append(row({ tenantId: t, runId: r, seq: 3, fence: 9 }));          // new owner
  await assert.rejects(store.append(row({ tenantId: t, runId: r, seq: 4, fence: 5 })), (e) => reject(e, FencedOut));
  assert.equal(await store.maxFence(t, r), 9);
  assert.equal(await store.maxFence(t, uuid()), 0);
});

itest('racing writers on one seq: exactly one wins, every round', async () => {
  const t = uuid(), r = uuid();
  for (let seq = 1; seq <= 10; seq++) {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => store.append(row({ tenantId: t, runId: r, seq, fence: 1 + i }))));
    const won = results.filter(x => x.status === 'fulfilled').length;
    assert.equal(won, 1, `round ${seq}`);
    for (const x of results) if (x.status === 'rejected') assert.ok(x.reason instanceof SeqConflict || x.reason instanceof FencedOut, String(x.reason));
  }
  const { rows } = await admin.query('SELECT seq::int AS seq FROM run_events WHERE run_id = $1 ORDER BY seq', [r]);
  assert.deepEqual(rows.map(x => x.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);      // no gaps, no duplicates
});

itest('branches are independent for both seq and fence', async () => {
  const t = uuid(), r = uuid();
  await store.append(row({ tenantId: t, runId: r, branchId: 0, seq: 1, fence: 10 }));
  await store.append(row({ tenantId: t, runId: r, branchId: 1, seq: 1, fence: 2 }));
  await assert.rejects(store.append(row({ tenantId: t, runId: r, branchId: 0, seq: 2, fence: 2 })), (e) => reject(e, FencedOut));
  await store.append(row({ tenantId: t, runId: r, branchId: 1, seq: 2, fence: 2 }));
});

itest('row-level security isolates tenants and rejects cross-tenant writes', async () => {
  const a = uuid(), b = uuid(), r = uuid();
  await store.append(row({ tenantId: a, runId: r, seq: 1, fence: 1 }));
  await store.append(row({ tenantId: b, runId: r, seq: 1, fence: 1 }));
  const c = await app.connect();
  try {
    for (const [tenant, other] of [[a, b], [b, a]] as const) {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
      const seen = await c.query('SELECT tenant_id FROM run_events WHERE run_id = $1', [r]);
      assert.deepEqual(seen.rows.map(x => x.tenant_id), [tenant]);
      const peek = await c.query('SELECT 1 FROM run_events WHERE tenant_id = $1', [other]);
      assert.equal(peek.rowCount, 0);
      await c.query('COMMIT');
    }
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [b]);
    await assert.rejects(
      c.query(`INSERT INTO run_events (tenant_id, run_id, seq, fence, to_state, artifact) VALUES ($1, $2, 99, 1, 'X', '{}')`, [a, r]),
      (e: { code?: string }) => e.code === '42501');
    await c.query('ROLLBACK');
  } finally { c.release(); }
});

itest('the application role is append-only (denied by GRANTs, with a valid tenant bound)', async () => {
  const c = await app.connect();
  try {
    for (const sql of [`UPDATE run_events SET to_state = 'X'`, 'DELETE FROM run_events']) {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [uuid()]);   // valid tenant, so the denial cannot come from RLS
      await assert.rejects(c.query(sql), (e: { code?: string }) => e.code === '42501', sql);
      await c.query('ROLLBACK');
    }
  } finally { c.release(); }
});

itest('with no tenant bound, RLS fails closed: nothing is visible and nothing can be inserted', async () => {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    assert.equal((await c.query('SELECT 1 FROM run_events')).rowCount, 0);
    await assert.rejects(
      c.query(`INSERT INTO run_events (tenant_id, run_id, seq, fence, to_state, artifact) VALUES ($1, $2, 1, 1, 'X', '{}')`, [uuid(), uuid()]),
      (e: { code?: string }) => e.code === '42501');
    await c.query('ROLLBACK');
  } finally { c.release(); }
});

itest('rows spread across hash partitions', async () => {
  for (let i = 0; i < 16; i++) await store.append(row({ tenantId: uuid(), runId: uuid(), seq: 1, fence: 1 }));
  const { rows } = await admin.query(`SELECT tableoid::regclass::text AS p, count(*)::int AS n FROM run_events GROUP BY 1`);
  assert.ok(rows.length >= 2, JSON.stringify(rows));
});

itest('failed appends do not leak connections or leave transactions open', async () => {
  const t = uuid(), r = uuid();
  await store.append(row({ tenantId: t, runId: r, seq: 1, fence: 1 }));
  for (let i = 0; i < 60; i++) await assert.rejects(store.append(row({ tenantId: t, runId: r, seq: 1, fence: 1 })));
  assert.equal(app.waitingCount, 0);
  assert.equal(app.idleCount, app.totalCount);
  await store.append(row({ tenantId: t, runId: r, seq: 2, fence: 1 }));
});
