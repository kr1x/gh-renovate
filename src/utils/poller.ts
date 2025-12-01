/**
 * Polling utilities with adaptive intervals
 */

import { PollingTimeoutError } from '../errors/types.js';

export type PollingConditionResult = 'continue' | 'done' | 'abort';

export interface PollerOptions<T> {
  /** Initial interval between polls (ms) */
  initialIntervalMs: number;
  /** Maximum interval between polls (ms) */
  maxIntervalMs: number;
  /** Total timeout for the operation (ms) */
  timeoutMs: number;
  /** Function to check if we should stop polling */
  condition: (result: T) => PollingConditionResult;
  /** Optional: Adjust interval based on result */
  intervalAdjuster?: (result: T, currentInterval: number) => number;
  /** Called on each poll with result */
  onPoll?: (result: T, elapsedMs: number) => void;
  /** Operation name for error messages */
  operationName: string;
}

/**
 * Sleep for a given duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Poll a function until a condition is met
 */
export async function poll<T>(
  fn: () => Promise<T>,
  options: PollerOptions<T>
): Promise<T> {
  const startTime = Date.now();
  let interval = options.initialIntervalMs;
  let lastResult: T | undefined;

  while (true) {
    const elapsed = Date.now() - startTime;

    if (elapsed >= options.timeoutMs) {
      throw new PollingTimeoutError(
        options.operationName,
        options.timeoutMs
      );
    }

    try {
      lastResult = await fn();
      options.onPoll?.(lastResult, elapsed);

      const conditionResult = options.condition(lastResult);
      if (conditionResult === 'done') {
        return lastResult;
      }
      if (conditionResult === 'abort') {
        throw new Error(`Polling aborted for ${options.operationName}`);
      }

      // Adjust interval if adjuster provided
      if (options.intervalAdjuster) {
        interval = options.intervalAdjuster(lastResult, interval);
      } else {
        // Default: gradually increase interval
        interval = Math.min(interval * 1.2, options.maxIntervalMs);
      }
    } catch (error) {
      // Re-throw polling-specific errors
      if (error instanceof PollingTimeoutError) {
        throw error;
      }
      // For other errors, continue polling (they might be transient)
      // But still respect timeout
      if (Date.now() - startTime >= options.timeoutMs) {
        throw error;
      }
    }

    // Cap interval at maxInterval
    interval = Math.min(interval, options.maxIntervalMs);
    await sleep(interval);
  }
}

/**
 * Create a default poller configuration for CI checks
 */
export function createCICheckPollerOptions<T>(
  condition: (result: T) => PollingConditionResult,
  onPoll?: (result: T, elapsedMs: number) => void
): PollerOptions<T> {
  return {
    initialIntervalMs: 10_000, // Start at 10s
    maxIntervalMs: 60_000, // Max 1 minute between polls
    timeoutMs: 10 * 60 * 1000, // 10 minutes total
    operationName: 'CI checks',
    condition,
    onPoll,
  };
}

/**
 * Create a default poller configuration for rebase
 */
export function createRebasePollerOptions<T>(
  condition: (result: T) => PollingConditionResult,
  onPoll?: (result: T, elapsedMs: number) => void
): PollerOptions<T> {
  return {
    initialIntervalMs: 5_000, // Start at 5s
    maxIntervalMs: 30_000, // Max 30s between polls
    timeoutMs: 5 * 60 * 1000, // 5 minutes total
    operationName: 'rebase',
    condition,
    onPoll,
  };
}
