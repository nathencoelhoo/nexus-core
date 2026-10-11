export type ErrorClass = 'permanent' | 'auth' | 'transient' | 'throttled' | 'ambiguous';

export class ProviderHttpError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Job-level: do not retry. Mapped to BullMQ UnrecoverableError by the adapter. */
export class PermanentFailure extends Error {
  errorClass: 'permanent' | 'auth';
  constructor(message: string, errorClass: 'permanent' | 'auth' = 'permanent') {
    super(message);
    this.errorClass = errorClass;
  }
}

export class RetryableFailure extends Error {
  errorClass: ErrorClass;
  retryAfterMs?: number;
  constructor(message: string, errorClass: ErrorClass, retryAfterMs?: number) {
    super(message);
    this.errorClass = errorClass;
    this.retryAfterMs = retryAfterMs;
  }
}

export class InFlightError extends RetryableFailure {
  constructor() { super('another worker holds this action', 'transient'); }
}

export class LeaseLost extends Error {}
export class BackpressureError extends Error {}

/** Never sent: safe to treat as a clean failure. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH']);
/** May have been sent: the outcome is unknown. */
const MAYBE_SENT = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function codeOf(e: Error): string | undefined {
  const c = (e as { code?: unknown }).code;
  if (typeof c === 'string') return c;
  const cc = (e as { cause?: { code?: unknown } }).cause?.code;
  return typeof cc === 'string' ? cc : undefined;
}

/**
 * The key distinction is `ambiguous`: the request may have been executed even though we saw an error
 * (timeouts, resets, 5xx). Those must be resolved by the idempotency token or a lookup, never by "just retrying".
 */
export function classifyError(e: unknown): { cls: ErrorClass; retryAfterMs?: number } {
  if (e instanceof RetryableFailure) return { cls: e.errorClass, retryAfterMs: e.retryAfterMs };
  if (e instanceof PermanentFailure) return { cls: e.errorClass };
  if (e instanceof LeaseLost) return { cls: 'transient' };
  if (e instanceof ProviderHttpError) {
    const s = e.status;
    if (s === 401 || s === 403) return { cls: 'auth' };
    if (s === 429) return { cls: 'throttled', retryAfterMs: e.retryAfterMs };
    if (s === 408 || s >= 500) return { cls: 'ambiguous', retryAfterMs: e.retryAfterMs };
    if (s === 409) return { cls: 'transient', retryAfterMs: e.retryAfterMs }; // "same token still in progress"
    return { cls: 'permanent' };
  }
  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { cls: 'ambiguous' };
    const code = codeOf(e);
    if (code && NOT_SENT.has(code)) return { cls: 'transient' };
    if (code && MAYBE_SENT.has(code)) return { cls: 'ambiguous' };
    if (e instanceof TypeError && e.message === 'fetch failed') return { cls: 'ambiguous' };
    // Programming errors never heal by retrying: quarantine instead of burning attempts.
    if (e instanceof TypeError || e instanceof RangeError || e instanceof SyntaxError || e instanceof ReferenceError) {
      return { cls: 'permanent' };
    }
  }
  return { cls: 'transient' };
}
