/**
 * Custom error types for gh-renovate CLI
 */

export enum ErrorCode {
  // Authentication
  AUTH_TOKEN_MISSING = 'AUTH_TOKEN_MISSING',
  AUTH_TOKEN_INVALID = 'AUTH_TOKEN_INVALID',
  AUTH_INSUFFICIENT_PERMISSIONS = 'AUTH_INSUFFICIENT_PERMISSIONS',

  // Rate limiting
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  SECONDARY_RATE_LIMIT = 'SECONDARY_RATE_LIMIT',

  // PR state
  PR_NOT_FOUND = 'PR_NOT_FOUND',
  PR_ALREADY_MERGED = 'PR_ALREADY_MERGED',
  PR_CLOSED = 'PR_CLOSED',
  PR_HAS_CONFLICTS = 'PR_HAS_CONFLICTS',
  PR_NOT_MERGEABLE = 'PR_NOT_MERGEABLE',
  PR_CHECKS_FAILED = 'PR_CHECKS_FAILED',

  // Network
  NETWORK_TIMEOUT = 'NETWORK_TIMEOUT',
  NETWORK_ERROR = 'NETWORK_ERROR',

  // Renovate
  RENOVATE_CHECKBOX_NOT_FOUND = 'RENOVATE_CHECKBOX_NOT_FOUND',
  NOT_RENOVATE_PR = 'NOT_RENOVATE_PR',

  // Input
  INVALID_REPO_URL = 'INVALID_REPO_URL',

  // Timeout
  POLLING_TIMEOUT = 'POLLING_TIMEOUT',
}

export abstract class GhRenovateError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly recoverable: boolean;
  abstract readonly userMessage: string;

  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class AuthError extends GhRenovateError {
  readonly recoverable = false;

  constructor(
    readonly code: ErrorCode.AUTH_TOKEN_MISSING | ErrorCode.AUTH_TOKEN_INVALID | ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
    readonly userMessage: string,
    cause?: Error
  ) {
    super(userMessage, cause);
  }
}

export class RateLimitError extends GhRenovateError {
  readonly code = ErrorCode.RATE_LIMIT_EXCEEDED;
  readonly recoverable = true;

  constructor(
    public readonly resetAt: Date,
    public readonly remaining: number,
    cause?: Error
  ) {
    super(`Rate limit exceeded. Resets at ${resetAt.toISOString()}`, cause);
  }

  get userMessage(): string {
    const waitSeconds = Math.ceil((this.resetAt.getTime() - Date.now()) / 1000);
    return `GitHub rate limit reached. Waiting ${waitSeconds}s for reset...`;
  }
}

export class PRStateError extends GhRenovateError {
  readonly recoverable = false;

  constructor(
    readonly code:
      | ErrorCode.PR_NOT_FOUND
      | ErrorCode.PR_ALREADY_MERGED
      | ErrorCode.PR_CLOSED
      | ErrorCode.PR_HAS_CONFLICTS
      | ErrorCode.PR_NOT_MERGEABLE
      | ErrorCode.PR_CHECKS_FAILED,
    readonly prNumber: number,
    readonly userMessage: string,
    cause?: Error
  ) {
    super(`PR #${prNumber}: ${userMessage}`, cause);
  }
}

export class PollingTimeoutError extends GhRenovateError {
  readonly code = ErrorCode.POLLING_TIMEOUT;
  readonly recoverable = false;

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
    cause?: Error
  ) {
    super(`Timeout waiting for ${operation} after ${timeoutMs}ms`, cause);
  }

  get userMessage(): string {
    const timeoutSeconds = Math.round(this.timeoutMs / 1000);
    return `Timeout after ${timeoutSeconds}s waiting for ${this.operation}`;
  }
}

export class NetworkError extends GhRenovateError {
  readonly code = ErrorCode.NETWORK_ERROR;
  readonly recoverable = true;

  constructor(
    readonly userMessage: string,
    cause?: Error
  ) {
    super(userMessage, cause);
  }
}

export class ValidationError extends GhRenovateError {
  readonly recoverable = false;

  constructor(
    readonly code: ErrorCode.INVALID_REPO_URL,
    readonly userMessage: string,
    cause?: Error
  ) {
    super(userMessage, cause);
  }
}

export class RenovateError extends GhRenovateError {
  readonly recoverable = false;

  constructor(
    readonly code: ErrorCode.RENOVATE_CHECKBOX_NOT_FOUND | ErrorCode.NOT_RENOVATE_PR,
    readonly userMessage: string,
    cause?: Error
  ) {
    super(userMessage, cause);
  }
}

/**
 * Check if an error is a GhRenovateError
 */
export function isGhRenovateError(error: unknown): error is GhRenovateError {
  return error instanceof GhRenovateError;
}

/**
 * Check if an error is recoverable
 */
export function isRecoverableError(error: unknown): boolean {
  if (isGhRenovateError(error)) {
    return error.recoverable;
  }
  return false;
}
