export type StateName =
  | 'CODE' | 'COMPILE' | 'TEST' | 'PATCH'
  | 'SUCCESS' | 'ESCALATE' | 'BUDGET_EXHAUSTED' | 'FAILED_UNSAFE';

export const ABSORBING: ReadonlySet<StateName> =
  new Set(['SUCCESS', 'ESCALATE', 'BUDGET_EXHAUSTED', 'FAILED_UNSAFE']);

export interface Diagnostic {
  tool: string; code: string; message: string;
  file?: string; line?: number; frames?: string[];
}

/** Typed artifacts are the ONLY thing an executor may hand the reducer. */
export type Artifact =
  | { kind: 'patch_applied'; treeRoot: string }
  | { kind: 'compile_result'; exitCode: number; diagnostics: Diagnostic[]; treeRoot: string }
  | { kind: 'test_result'; failing: number; diagnostics: Diagnostic[]; treeRoot: string }
  | { kind: 'diff_applied'; treeRoot: string }
  | { kind: 'unsafe'; reason: string };

export type Score = readonly [compileErrors: number, failingTests: number];

export interface Config {
  maxTransitions: number; maxTokens: number; maxUsd: number; maxWallMs: number;
  maxPatchPerFp: number;  // failures tolerated per fingerprint
  stallWindow: number;    // non-improving transitions before rollback
  maxStrategy: number;    // rollbacks/strategy switches before ESCALATE
  visitedCap: number;     // ring size for cycle detector (fixed-size state)
}

export const DEFAULT_CONFIG: Config = {
  maxTransitions: 24, maxTokens: 400_000, maxUsd: 5, maxWallMs: 15 * 60_000,
  maxPatchPerFp: 2, stallWindow: 3, maxStrategy: 2, visitedCap: 64,
};

export interface Usage { tokens: number; usd: number; nowMs: number }

/** Fixed-size, reducer-merged state. Nothing unbounded lives here. */
export interface RunState {
  state: StateName;
  seq: number;              // event sequence; == transitions applied
  treeRoot: string;
  bestScore: Score | null;
  bestTreeRoot: string | null;
  noImprovement: number;
  fpAttempts: Record<string, number>;
  visited: string[];        // ring of 128-bit cycle keys
  strategy: number;
  tokens: number; usd: number; startedAtMs: number;
  reason?: string;
}

export type Directive =
  | { kind: 'rollback'; to: string; strategy: number }
  | { kind: 'none' };

export interface TransitionResult { next: RunState; directive: Directive }

export function initialState(treeRoot: string, nowMs: number): RunState {
  return {
    state: 'CODE', seq: 0, treeRoot, bestScore: null, bestTreeRoot: null,
    noImprovement: 0, fpAttempts: {}, visited: [], strategy: 0,
    tokens: 0, usd: 0, startedAtMs: nowMs,
  };
}
