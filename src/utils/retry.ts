/**
 * Retry utilities with exponential backoff
 */

import { sleep } from './poller.js';
import { GhRenovateError, RateLimitError, isRecoverableError } from '../errors/types.js';

export interface RetryOptions {
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Initial delay before first retry (ms) */
  initialDelayMs: number;
  /** Maximum delay between retries (ms) */
  maxDelayMs: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier: number;
  /** Custom condition to determine if error should be retried */
  retryCondition?: (error: unknown) => boolean;
  /** Called before each retry */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Check if an error is likely transient and should be retried
 */
export function isTransientError(error: unknown): boolean {
  // Our custom recoverable errors
  if (isRecoverableError(error)) {
    return true;
  }

  // Network errors
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('socket hang up') ||
      message.includes('network') ||
      message.includes('fetch failed')
    ) {
      return true;
    }
  }

  // HTTP errors that are typically transient
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status;
    // 5xx server errors, 429 rate limit
    if (status >= 500 || status === 429) {
      return true;
    }
  }

  return false;
}

/**
 * Execute a function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;
  let delay = opts.initialDelayMs;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      const shouldRetry = opts.retryCondition
        ? opts.retryCondition(error)
        : isTransientError(error);

      if (!shouldRetry) {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === opts.maxAttempts) {
        break;
      }

      // Handle rate limits specially - wait for reset
      if (error instanceof RateLimitError) {
        delay = Math.max(0, error.resetAt.getTime() - Date.now()) + 1000;
      }

      opts.onRetry?.(error, attempt, delay);

      await sleep(delay);

      // Exponential backoff for next attempt
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Create a retryable version of a function
 */
export function makeRetryable<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  options: Partial<RetryOptions> = {}
): T {
  return (async (...args: Parameters<T>) => {
    return withRetry(() => fn(...args), options);
  }) as T;
}
