/**
 * GitHub URL parsing utilities
 */

import { ValidationError, ErrorCode } from '../errors/types.js';

export interface RepoInfo {
  owner: string;
  repo: string;
}

const GITHUB_URL_PATTERNS = [
  // HTTPS: https://github.com/owner/repo or https://github.com/owner/repo.git
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?\/?$/,
  // SSH: git@github.com:owner/repo.git
  /^git@github\.com:([^/]+)\/([^/]+?)(\.git)?$/,
  // Simple: owner/repo
  /^([^/]+)\/([^/]+)$/,
];

/**
 * Parse a GitHub repository URL into owner and repo
 */
export function parseRepoUrl(url: string): RepoInfo {
  const trimmed = url.trim();

  for (const pattern of GITHUB_URL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return {
        owner: match[1],
        repo: match[2].replace(/\.git$/, ''),
      };
    }
  }

  throw new ValidationError(
    ErrorCode.INVALID_REPO_URL,
    `Invalid GitHub repository URL: "${url}". Expected format: https://github.com/owner/repo or owner/repo`
  );
}

/**
 * Build a GitHub URL from owner and repo
 */
export function buildRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

/**
 * Build a PR URL
 */
export function buildPRUrl(owner: string, repo: string, prNumber: number): string {
  return `https://github.com/${owner}/${repo}/pull/${prNumber}`;
}
