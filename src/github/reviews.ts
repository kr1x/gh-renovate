/**
 * Review/Approval operations
 */

import type { GitHubClient } from './client.js';
import type { ReviewInfo } from './types.js';

/**
 * Get review information for a PR
 */
export async function getReviewInfo(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number
): Promise<ReviewInfo> {
  const { data: reviews } = await client.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  // Track the latest review state per user
  const reviewsByUser = new Map<string, string>();

  for (const review of reviews) {
    if (!review.user?.login) continue;

    // Only track meaningful states
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' || review.state === 'DISMISSED') {
      reviewsByUser.set(review.user.login, review.state);
    }
  }

  const approvedBy: string[] = [];
  const changesRequestedBy: string[] = [];

  for (const [user, state] of reviewsByUser) {
    if (state === 'APPROVED') {
      approvedBy.push(user);
    } else if (state === 'CHANGES_REQUESTED') {
      changesRequestedBy.push(user);
    }
  }

  return {
    hasApproval: approvedBy.length > 0,
    approvedBy,
    changesRequested: changesRequestedBy.length > 0,
    changesRequestedBy,
  };
}

/**
 * Approve a PR
 */
export async function approvePullRequest(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  await client.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event: 'APPROVE',
  });
}

/**
 * Check if the current user has already approved
 */
export async function hasCurrentUserApproved(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number
): Promise<boolean> {
  // Get current user
  const { data: currentUser } = await client.users.getAuthenticated();

  const reviewInfo = await getReviewInfo(client, owner, repo, prNumber);

  return reviewInfo.approvedBy.includes(currentUser.login);
}
