import { ProviderHttpError } from '../../jobs/errors.ts';

const THROTTLE = new Set(['RequestLimitExceeded', 'Throttling', 'ThrottlingException', 'ThrottledException', 'TooManyRequestsException', 'RequestThrottled']);
const AUTH = new Set(['UnauthorizedOperation', 'AuthFailure', 'OptInRequired', 'InvalidClientTokenId', 'ExpiredToken', 'ExpiredTokenException',
  'SignatureDoesNotMatch', 'AccessDenied', 'AccessDeniedException', 'UnrecognizedClientException']);
/** Needs a human: raise the quota or free capacity. Retrying changes nothing. */
const QUOTA = new Set(['InstanceLimitExceeded', 'VcpuLimitExceeded', 'MaxSpotInstanceCountExceeded']);
const CAPACITY = new Set(['InsufficientInstanceCapacity', 'InsufficientHostCapacity']);
const INTERNAL = new Set(['InternalError', 'InternalFailure', 'ServiceUnavailable', 'Unavailable']);
const PARAM = new Set(['MissingParameter', 'ValidationError', 'UnsupportedOperation', 'OperationNotPermitted']);

interface AwsLike { name?: string; message?: string; Code?: string; $metadata?: { httpStatusCode?: number } }

/**
 * Translate an AWS SDK error into the error classes the retry machinery understands (ProviderHttpError status codes).
 * Anything not recognized is returned unchanged, so timeouts and socket errors still reach classifyError as 'ambiguous'.
 * The mapping lives in the action layer, not the SDK wrapper, so tests exercise it through a fake that throws SDK-shaped errors.
 */
export function mapAwsError(e: unknown): unknown {
  if (e instanceof ProviderHttpError) return e;
  if (typeof e !== 'object' || e === null) return e;
  const x = e as AwsLike;
  const name = x.Code ?? x.name ?? '';
  const status = x.$metadata?.httpStatusCode;
  const msg = `${name}: ${x.message ?? ''}`.trim();
  const wrap = (s: number, m: string = msg): ProviderHttpError => { const p = new ProviderHttpError(s, m); p.cause = e; return p; };

  if (name === 'AbortError' || name === 'TimeoutError') return e;
  if (THROTTLE.has(name)) return wrap(429);
  if (AUTH.has(name)) return wrap(403);
  if (QUOTA.has(name)) return wrap(403, `${msg} (quota: a human must raise the limit or free capacity)`);
  if (name === 'IdempotentParameterMismatch') return wrap(400, `${msg} (the same ClientToken was reused with different parameters: a key-derivation bug)`);
  if (CAPACITY.has(name) || INTERNAL.has(name)) return wrap(503);
  if (name.startsWith('Invalid') || PARAM.has(name)) return wrap(400);
  if (typeof status === 'number' && status >= 400) return wrap(status);
  return e;
}
