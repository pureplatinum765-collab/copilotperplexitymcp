/**
 * Backoff helper used to retry transient upstream failures.
 *
 * GitHub returns two flavours of rate limit: a primary quota (resets at a
 * fixed Unix timestamp in `x-ratelimit-reset`) and a secondary / abuse limit
 * (signals with `retry-after` in seconds). StackOne uses the standard
 * `Retry-After` header. This helper handles both via the
 * `RateLimitError.retryAfterSeconds` field — callers throw it and we sleep.
 */

import { RateLimitError } from './errors';
import { log } from './logger';

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  retryOnStatus?: ReadonlySet<number>;
}

const DEFAULT_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface RetryableError extends Error {
  status?: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const retryOnStatus = options.retryOnStatus ?? DEFAULT_RETRYABLE_STATUS;

  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const status = (err as RetryableError)?.status;
      const isRateLimit = err instanceof RateLimitError;
      const retryable = isRateLimit || (typeof status === 'number' && retryOnStatus.has(status));

      if (!retryable || attempt >= maxAttempts) {
        throw err;
      }

      const backoffMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const waitMs = isRateLimit
        ? Math.max(backoffMs, (err as RateLimitError).retryAfterSeconds * 1000)
        : backoffMs;

      log.warn('retrying after transient failure', {
        attempt,
        max_attempts: maxAttempts,
        status,
        wait_ms: waitMs,
        rate_limited: isRateLimit
      });

      await sleep(waitMs);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
