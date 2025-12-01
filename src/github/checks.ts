/**
 * CI Check operations
 */

import type { GitHubClient } from './client.js';
import type { ChecksStatus, CheckDetail } from './types.js';

/**
 * Get combined check status for a PR
 * Combines both GitHub Actions (check_runs) and legacy CI (commit status)
 */
export async function getChecksStatus(
  client: GitHubClient,
  owner: string,
  repo: string,
  sha: string
): Promise<ChecksStatus> {
  // Fetch both check runs and commit status in parallel
  const [checkRunsResponse, commitStatusResponse] = await Promise.all([
    client.checks.listForRef({
      owner,
      repo,
      ref: sha,
      per_page: 100,
    }),
    client.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: sha,
    }),
  ]);

  const details: CheckDetail[] = [];
  let total = 0;
  let completed = 0;
  let successful = 0;
  let failed = 0;
  let pending = 0;

  // Process check runs (GitHub Actions, etc.)
  for (const run of checkRunsResponse.data.check_runs) {
    total++;
    details.push({
      name: run.name,
      status: run.status as 'queued' | 'in_progress' | 'completed',
      conclusion: run.conclusion,
    });

    if (run.status === 'completed') {
      completed++;
      if (run.conclusion === 'success' || run.conclusion === 'skipped' || run.conclusion === 'neutral') {
        successful++;
      } else if (run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'cancelled') {
        failed++;
      }
    } else {
      pending++;
    }
  }

  // Process commit statuses (legacy CI systems)
  for (const status of commitStatusResponse.data.statuses) {
    // Avoid duplicates - check runs and statuses can overlap
    const existingDetail = details.find((d) => d.name === status.context);
    if (existingDetail) {
      continue;
    }

    total++;
    const isCompleted = status.state !== 'pending';
    details.push({
      name: status.context,
      status: isCompleted ? 'completed' : 'in_progress',
      conclusion: status.state === 'pending' ? null : status.state,
    });

    if (isCompleted) {
      completed++;
      if (status.state === 'success') {
        successful++;
      } else if (status.state === 'failure' || status.state === 'error') {
        failed++;
      }
    } else {
      pending++;
    }
  }

  // Determine overall state
  let state: ChecksStatus['state'];
  if (failed > 0) {
    state = 'failure';
  } else if (pending > 0 || completed < total) {
    state = 'pending';
  } else if (successful === total) {
    state = 'success';
  } else {
    state = 'error';
  }

  return {
    state,
    total,
    completed,
    successful,
    failed,
    pending,
    details,
  };
}

/**
 * Format failed checks for display
 */
export function formatFailedChecks(status: ChecksStatus): string {
  const failedChecks = status.details.filter(
    (d) =>
      d.conclusion === 'failure' ||
      d.conclusion === 'timed_out' ||
      d.conclusion === 'cancelled' ||
      d.conclusion === 'error'
  );

  if (failedChecks.length === 0) {
    return 'No failed checks';
  }

  return failedChecks.map((c) => `${c.name} (${c.conclusion})`).join(', ');
}

/**
 * Check if all required checks have passed
 */
export function areChecksPassing(status: ChecksStatus): boolean {
  return status.state === 'success';
}

/**
 * Check if checks are still running
 */
export function areChecksPending(status: ChecksStatus): boolean {
  return status.state === 'pending';
}

/**
 * Check if any checks have failed
 */
export function areChecksFailing(status: ChecksStatus): boolean {
  return status.state === 'failure' || status.state === 'error';
}
