import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transition } from '../src/reducer.ts';
import { normalizeMessage, fingerprint } from '../src/fingerprint.ts';
import { reduceStack, truncateHeadTail } from '../src/context.ts';
import { DEFAULT_CONFIG as cfg, initialState, type Artifact, type Diagnostic } from '../src/types.ts';

const u = { tokens: 100, usd: 0.01, nowMs: 1000 };
const diag = (message: string): Diagnostic => ({ tool: 'tsc', code: 'TS2322', message });
const step = (s: ReturnType<typeof initialState>, a: Artifact, over = {}) =>
  transition(s, a, { ...u, ...over }, cfg);

test('happy path reaches SUCCESS', () => {
  let s = initialState('t0', 0);
  s = step(s, { kind: 'patch_applied', treeRoot: 't1' }).next;
  s = step(s, { kind: 'compile_result', exitCode: 0, diagnostics: [], treeRoot: 't1' }).next;
  s = step(s, { kind: 'test_result', failing: 0, diagnostics: [], treeRoot: 't1' }).next;
  assert.equal(s.state, 'SUCCESS');
  assert.throws(() => step(s, { kind: 'patch_applied', treeRoot: 'x' }));
});

test('same fingerprint a 3rd time -> ESCALATE', () => {
  let s = initialState('t0', 0);
  s = step(s, { kind: 'patch_applied', treeRoot: 't1' }).next;
  for (let i = 0; i < 3; i++) {
    s = step(s, { kind: 'compile_result', exitCode: 1, diagnostics: [diag(`bad at /tmp/x${i}/a.ts:${i}:1`)], treeRoot: `t${i + 2}` }).next;
    if (s.state === 'PATCH') s = step(s, { kind: 'diff_applied', treeRoot: `p${i}` }).next;
  }
  assert.equal(s.state, 'ESCALATE');
  assert.match(s.reason!, /^fp_exhausted/);
});

test('A->B->A oscillation triggers rollback to best tree', () => {
  let s = initialState('t0', 0);
  s = step(s, { kind: 'patch_applied', treeRoot: 'A' }).next;
  const fail = (m: string, root: string) =>
    step(s, { kind: 'compile_result', exitCode: 1, diagnostics: [diag(m)], treeRoot: root });
  let r = fail('err one', 'A'); s = r.next; assert.equal(s.state, 'PATCH');
  s = step(s, { kind: 'diff_applied', treeRoot: 'B' }).next;
  r = fail('err two', 'B'); s = r.next;
  s = step(s, { kind: 'diff_applied', treeRoot: 'A' }).next;
  r = fail('err one', 'A');
  assert.equal(r.directive.kind, 'rollback');
  assert.equal(r.next.state, 'PATCH');
  assert.equal(r.next.reason, 'oscillation');
});

test('stall (no score improvement) rolls back', () => {
  let s = initialState('t0', 0);
  s = step(s, { kind: 'patch_applied', treeRoot: 'r0' }).next;
  let last;
  for (let i = 0; i < 5 && s.state !== 'ESCALATE'; i++) {
    last = step(s, { kind: 'compile_result', exitCode: 1, diagnostics: [diag(`distinct ${i}`)], treeRoot: `r${i + 1}` });
    s = last.next;
    if (last.directive.kind === 'rollback') break;
    s = step(s, { kind: 'diff_applied', treeRoot: `d${i}` }).next;
  }
  assert.equal(last!.directive.kind, 'rollback');
  assert.equal(last!.next.reason, 'stall');
});

test('budgets enforced in reducer', () => {
  const s = initialState('t0', 0);
  assert.equal(step(s, { kind: 'patch_applied', treeRoot: 'x' }, { tokens: 1e9 }).next.state, 'BUDGET_EXHAUSTED');
  assert.equal(step(s, { kind: 'patch_applied', treeRoot: 'x' }, { nowMs: 1e12 }).next.reason, 'max_wall');
  assert.equal(step(s, { kind: 'unsafe', reason: 'escape attempt' }).next.state, 'FAILED_UNSAFE');
});

test('fingerprint ignores paths, lines, hex, pids', () => {
  assert.equal(
    fingerprint(diag('Cannot find /home/a/b/foo.ts:12:5 at 0xdeadbeef pid 4242')),
    fingerprint(diag('Cannot find /var/w/q/foo.ts:99:1 at 0xcafe pid 7')));
  assert.equal(normalizeMessage('x /a/b/c.ts:1:2'), 'x c.ts');
});

test('context reducers', () => {
  const frames = ['at a (/s/a.ts:1:1)', 'at a (/s/a.ts:1:1)', 'at x (node_modules/z.js:1:1)', 'at b (/s/b.ts:2:2)'];
  assert.deepEqual(reduceStack(frames), ['at a (/s/a.ts:1:1) ×2', 'at b (/s/b.ts:2:2)']);
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
  const out = truncateHeadTail(big, 200, 'blob:ab12');
  assert.match(out, /lines elided, ref=blob:ab12/);
  assert.ok(out.length < big.length / 4);
});
