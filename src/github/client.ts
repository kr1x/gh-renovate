/**
 * GitHub API client with retry and throttling
 */

import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { AuthError, ErrorCode } from '../errors/types.js';

export interface ClientOptions {
  token: string;
  onRateLimit?: (retryAfter: number, options: object) => void;
  onSecondaryRateLimit?: (retryAfter: number, options: object) => void;
}

// Use Octokit directly as the type - the plugins add functionality but don't change the interface significantly
export type GitHubClient = Octokit;

// Create custom Octokit with plugins
const CustomOctokit = Octokit.plugin(retry, throttling);

/**
 * Create a GitHub client with retry and throttling configured
 */
export function createGitHubClient(options: ClientOptions): GitHubClient {
  return new CustomOctokit({
    auth: options.token,

    throttle: {
      onRateLimit: (retryAfter, opts, _octokit, retryCount) => {
        const typedOpts = opts as { method: string; url: string };
        console.warn(
          `Rate limit hit for ${typedOpts.method} ${typedOpts.url}. Retry ${retryCount + 1} after ${retryAfter}s`
        );

        options.onRateLimit?.(retryAfter, opts);

        // Retry up to 3 times
        if (retryCount < 3) {
          return true;
        }
        return false;
      },

      onSecondaryRateLimit: (retryAfter, opts, _octokit, retryCount) => {
        const typedOpts = opts as { method: string; url: string };
        console.warn(
          `Secondary rate limit hit for ${typedOpts.method} ${typedOpts.url}. Retry ${retryCount + 1} after ${retryAfter}s`
        );

        options.onSecondaryRateLimit?.(retryAfter, opts);

        // More conservative retry for abuse limits
        if (retryCount < 2) {
          return true;
        }
        return false;
      },
    },

    retry: {
      doNotRetry: ['429'], // Handled by throttling plugin
      retries: 3,
    },

    request: {
      timeout: 30_000, // 30s timeout per request
    },
  });
}

/**
 * Get GitHub token from environment or throw error
 */
export function getGitHubTokenFromEnv(): string {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new AuthError(
      ErrorCode.AUTH_TOKEN_MISSING,
      'GitHub token required. Set GITHUB_TOKEN environment variable or provide via --token flag.'
    );
  }
  return token;
}

/**
 * Validate that the token works by making a simple API call
 */
export async function validateToken(client: GitHubClient): Promise<void> {
  try {
    await client.users.getAuthenticated();
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) {
      const status = (error as { status: number }).status;
      if (status === 401) {
        throw new AuthError(
          ErrorCode.AUTH_TOKEN_INVALID,
          'GitHub token is invalid or expired.'
        );
      }
      if (status === 403) {
        throw new AuthError(
          ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
          'GitHub token does not have sufficient permissions.'
        );
      }
    }
    throw error;
  }
}
