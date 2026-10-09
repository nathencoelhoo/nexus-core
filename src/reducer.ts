import { ABSORBING, type Artifact, type Config, type Diagnostic, type Directive,
  type RunState, type Score, type StateName, type TransitionResult, type Usage } from './types.ts';
import { failureSetFingerprint, sha256 } from './fingerprint.ts';

export class IllegalTransition extends Error {}

const EXPECTS: Partial<Record<StateName, Artifact['kind']>> = {
  CODE: 'patch_applied', COMPILE: 'compile_result', TEST: 'test_result', PATCH: 'diff_applied',
};

/** Lexicographic order on (compileErrors, failingTests). */
export const cmpScore = (a: Score, b: Score): number => a[0] - b[0] || a[1] - b[1];
const NO_TESTS_RUN = 1e9;

function clone(s: RunState): RunState {
  return { ...s, fpAttempts: { ...s.fpAttempts }, visited: [...s.visited] };
}

function terminal(s: RunState, to: StateName, reason: string): TransitionResult {
  return { next: { ...s, state: to, reason }, directive: { kind: 'none' } };
}

/**
 * δ(state, artifact, usage, config) → state'. Pure and deterministic:
 * no clock, no I/O; time arrives through `usage.nowMs`.
 */
export function transition(
  cur: RunState, a: Artifact, u: Usage, cfg: Config,
): TransitionResult {
  if (ABSORBING.has(cur.state)) throw new IllegalTransition(`absorbing state ${cur.state}`);

  const s = clone(cur);
  s.seq += 1;
  s.tokens += u.tokens;
  s.usd += u.usd;

  if (a.kind === 'unsafe') return terminal(s, 'FAILED_UNSAFE', a.reason);

  // Budgets are enforced in the reducer, never in a prompt.
  if (s.seq > cfg.maxTransitions) return terminal(s, 'BUDGET_EXHAUSTED', 'max_transitions');
  if (s.tokens > cfg.maxTokens)   return terminal(s, 'BUDGET_EXHAUSTED', 'max_tokens');
  if (s.usd > cfg.maxUsd)         return terminal(s, 'BUDGET_EXHAUSTED', 'max_usd');
  if (u.nowMs - s.startedAtMs > cfg.maxWallMs) return terminal(s, 'BUDGET_EXHAUSTED', 'max_wall');

  if (EXPECTS[cur.state] !== a.kind)
    throw new IllegalTransition(`${cur.state} cannot accept ${a.kind}`);

  s.treeRoot = a.treeRoot;

  switch (a.kind) {
    case 'patch_applied':
      return ok(s, 'COMPILE');
    case 'diff_applied':
      return ok(s, 'COMPILE');
    case 'compile_result':
      if (a.exitCode === 0 && a.diagnostics.length === 0) return ok(s, 'TEST');
      return failure(s, cur.state, [Math.max(a.diagnostics.length, 1), NO_TESTS_RUN], a.diagnostics, cfg);
    case 'test_result':
      if (a.failing === 0) return ok(s, 'SUCCESS');
      return failure(s, cur.state, [0, a.failing], a.diagnostics, cfg);
  }
}

function ok(s: RunState, to: StateName): TransitionResult {
  return { next: { ...s, state: to }, directive: { kind: 'none' } };
}

function failure(
  s: RunState, from: StateName, score: Score, diags: Diagnostic[], cfg: Config,
): TransitionResult {
  // 4. Monotonic progress.
  if (!s.bestScore || cmpScore(score, s.bestScore) < 0) {
    s.bestScore = score; s.bestTreeRoot = s.treeRoot; s.noImprovement = 0;
  } else {
    s.noImprovement += 1;
  }

  // 2. Fingerprint budget.
  const fp = failureSetFingerprint(diags);
  const n = (s.fpAttempts[fp] ?? 0) + 1;
  s.fpAttempts[fp] = n;
  if (n > cfg.maxPatchPerFp) return terminal(s, 'ESCALATE', `fp_exhausted:${fp.slice(0, 12)}`);

  // 3. Workspace-state cycle detection (A -> B -> A).
  const key = sha256(`${from}|${s.treeRoot}|${fp}`).slice(0, 32);
  if (s.visited.includes(key)) return rollbackOrEscalate(s, cfg, 'oscillation');
  s.visited.push(key);
  if (s.visited.length > cfg.visitedCap) s.visited.shift();

  if (s.noImprovement >= cfg.stallWindow) return rollbackOrEscalate(s, cfg, 'stall');

  return ok(s, 'PATCH');
}

function rollbackOrEscalate(s: RunState, cfg: Config, why: string): TransitionResult {
  if (s.strategy >= cfg.maxStrategy || !s.bestTreeRoot) return terminal(s, 'ESCALATE', why);
  const directive: Directive = { kind: 'rollback', to: s.bestTreeRoot, strategy: s.strategy + 1 };
  return {
    next: { ...s, state: 'PATCH', treeRoot: s.bestTreeRoot, strategy: s.strategy + 1,
            noImprovement: 0, reason: why },
    directive,
  };
}
