import { createHash } from 'node:crypto';

export class NonCanonicalError extends Error {}

/**
 * Canonical JSON: sorted keys, no whitespace. Rejects everything JSON.stringify would silently
 * mangle (undefined, NaN, Date, Map, class instances), because a silently different encoding
 * means a different key, which means a duplicate external side effect.
 */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new NonCanonicalError('non-finite number');
      return Object.is(v, -0) ? '0' : JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new NonCanonicalError('non-plain object');
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o).sort().map(k => {
        if (o[k] === undefined) throw new NonCanonicalError(`undefined value at key "${k}"`);
        return `${JSON.stringify(k)}:${canonicalJson(o[k])}`;
      }).join(',')}}`;
    }
    default: throw new NonCanonicalError(`unsupported type ${typeof v}`);
  }
}

export interface KeyParts {
  tenantId: string;
  runId: string;
  /** Deterministic position of this action in the run (e.g. Section 1 `branch:seq`). NEVER the retry attempt. */
  stepId: string;
  action: string;
  params: unknown;
}

/**
 * key = sha256 over length-prefixed fields, so ("a","bc") and ("ab","c") cannot collide.
 * 64 hex chars: fits AWS EC2 ClientToken (max 64) exactly, and is well under Stripe's 255.
 * The same key is the ledger primary key AND the provider-side idempotency token.
 */
export function idempotencyKey(p: KeyParts): string {
  const h = createHash('sha256');
  for (const s of [p.tenantId, p.runId, p.stepId, p.action, canonicalJson(p.params)]) {
    h.update(`${Buffer.byteLength(s)}:`);
    h.update(s);
    h.update(';');
  }
  return h.digest('hex');
}
