/**
 * Renovate rebase triggering
 */

import type { GitHubClient } from '../github/client.js';
import type { PullRequest } from '../github/types.js';
import { updatePullRequestBody } from '../github/pulls.js';
import { RenovateError, ErrorCode } from '../errors/types.js';

// Patterns for finding the rebase checkbox in PR body
const REBASE_CHECKBOX_PATTERNS = [
  // Standard Renovate checkbox
  /- \[ \] <!-- rebase-check -->/,
  // Alternative formats
  /- \[ \] If you want to rebase\/retry this PR/i,
  /- \[ \] Rebase this PR/i,
  /\[ \] <!-- renovate-rebase -->/,
];

// Patterns for already checked checkbox
const CHECKED_PATTERNS = [
  /- \[x\] <!-- rebase-check -->/i,
  /- \[x\] If you want to rebase\/retry this PR/i,
  /- \[x\] Rebase this PR/i,
  /\[x\] <!-- renovate-rebase -->/i,
];

/**
 * Check if the rebase checkbox is already checked
 */
export function isRebaseAlreadyTriggered(body: string): boolean {
  return CHECKED_PATTERNS.some((pattern) => pattern.test(body));
}

/**
 * Check if the PR body has a rebase checkbox
 */
export function hasRebaseCheckbox(body: string): boolean {
  return (
    REBASE_CHECKBOX_PATTERNS.some((pattern) => pattern.test(body)) ||
    CHECKED_PATTERNS.some((pattern) => pattern.test(body))
  );
}

/**
 * Trigger a rebase by checking the checkbox in the PR body
 */
export async function triggerRebase(
  client: GitHubClient,
  owner: string,
  repo: string,
  pr: PullRequest
): Promise<'checkbox' | 'comment'> {
  const body = pr.body ?? '';

  // Check if already triggered
  if (isRebaseAlreadyTriggered(body)) {
    // Already triggered, nothing to do
    return 'checkbox';
  }

  // Try to find and check the checkbox
  for (const pattern of REBASE_CHECKBOX_PATTERNS) {
    if (pattern.test(body)) {
      const newBody = body.replace(pattern, (match) => {
        return match.replace('[ ]', '[x]');
      });

      await updatePullRequestBody(client, owner, repo, pr.number, newBody);
      return 'checkbox';
    }
  }

  // No checkbox found - fall back to comment
  // Some Renovate configs respond to @renovate rebase comment
  await client.issues.createComment({
    owner,
    repo,
    issue_number: pr.number,
    body: '@renovate rebase',
  });

  return 'comment';
}

/**
 * Wait for Renovate to push a new commit after rebase
 */
export async function hasNewCommitSince(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  previousSha: string
): Promise<{ hasNewCommit: boolean; currentSha: string }> {
  const { data: pr } = await client.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  return {
    hasNewCommit: pr.head.sha !== previousSha,
    currentSha: pr.head.sha,
  };
}

/**
 * Check if rebase can be triggered for this PR
 */
export function canTriggerRebase(pr: PullRequest): { canTrigger: boolean; reason?: string } {
  const body = pr.body ?? '';

  if (!hasRebaseCheckbox(body)) {
    return {
      canTrigger: true, // We can still try via comment
      reason: 'No rebase checkbox found, will try comment method',
    };
  }

  if (isRebaseAlreadyTriggered(body)) {
    return {
      canTrigger: false,
      reason: 'Rebase already triggered',
    };
  }

  return { canTrigger: true };
}
