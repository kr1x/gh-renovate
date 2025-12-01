/**
 * Pull Request operations
 */

import type { GitHubClient } from './client.js';
import type { PullRequest, MergeMethod, MergeResult } from './types.js';
import { PRStateError, ErrorCode } from '../errors/types.js';

/**
 * Map GitHub API response to our PullRequest type
 */
function mapToPullRequest(data: Awaited<ReturnType<GitHubClient['pulls']['get']>>['data']): PullRequest {
  return {
    number: data.number,
    title: data.title,
    body: data.body,
    state: data.state as 'open' | 'closed',
    merged: data.merged,
    draft: data.draft ?? false,
    mergeable: data.mergeable,
    mergeableState: data.mergeable_state,
    htmlUrl: data.html_url,
    user: data.user ? { login: data.user.login } : null,
    head: {
      sha: data.head.sha,
      ref: data.head.ref,
    },
    base: {
      ref: data.base.ref,
    },
    labels: data.labels.map((l) => ({
      name: typeof l === 'string' ? l : l.name ?? '',
    })),
  };
}

/**
 * List all open pull requests for a repository
 */
export async function listOpenPullRequests(
  client: GitHubClient,
  owner: string,
  repo: string
): Promise<PullRequest[]> {
  const pulls: PullRequest[] = [];

  // Paginate through all open PRs
  for await (const response of client.paginate.iterator(client.pulls.list, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  })) {
    for (const pr of response.data) {
      pulls.push({
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state as 'open' | 'closed',
        merged: false, // Open PRs are not merged
        draft: pr.draft ?? false,
        mergeable: null, // Need to fetch individually for this
        mergeableState: '',
        htmlUrl: pr.html_url,
        user: pr.user ? { login: pr.user.login } : null,
        head: {
          sha: pr.head.sha,
          ref: pr.head.ref,
        },
        base: {
          ref: pr.base.ref,
        },
        labels: pr.labels.map((l) => ({
          name: typeof l === 'string' ? l : l.name ?? '',
        })),
      });
    }
  }

  return pulls;
}

/**
 * Get detailed information about a specific PR
 */
export async function getPullRequest(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PullRequest> {
  try {
    const { data } = await client.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    return mapToPullRequest(data);
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) {
      const status = (error as { status: number }).status;
      if (status === 404) {
        throw new PRStateError(
          ErrorCode.PR_NOT_FOUND,
          prNumber,
          'PR not found (may have been deleted)'
        );
      }
    }
    throw error;
  }
}

/**
 * Update a PR's body
 */
export async function updatePullRequestBody(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  await client.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    body,
  });
}

/**
 * Merge a pull request
 */
export async function mergePullRequest(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  options: {
    mergeMethod?: MergeMethod;
    commitTitle?: string;
  } = {}
): Promise<MergeResult> {
  // First, get fresh PR data to validate state
  const pr = await getPullRequest(client, owner, repo, prNumber);

  if (pr.merged) {
    throw new PRStateError(
      ErrorCode.PR_ALREADY_MERGED,
      prNumber,
      'PR was already merged'
    );
  }

  if (pr.state === 'closed') {
    throw new PRStateError(
      ErrorCode.PR_CLOSED,
      prNumber,
      'PR was closed'
    );
  }

  if (pr.mergeableState === 'dirty') {
    throw new PRStateError(
      ErrorCode.PR_HAS_CONFLICTS,
      prNumber,
      'PR has merge conflicts that require manual resolution'
    );
  }

  if (pr.mergeable === false) {
    throw new PRStateError(
      ErrorCode.PR_NOT_MERGEABLE,
      prNumber,
      `PR is not mergeable (state: ${pr.mergeableState})`
    );
  }

  try {
    const { data } = await client.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      merge_method: options.mergeMethod ?? 'squash',
      commit_title: options.commitTitle,
    });

    return {
      sha: data.sha,
      merged: data.merged,
      message: data.message,
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) {
      const status = (error as { status: number }).status;
      if (status === 405) {
        throw new PRStateError(
          ErrorCode.PR_NOT_MERGEABLE,
          prNumber,
          'PR cannot be merged (method not allowed or requirements not met)'
        );
      }
      if (status === 409) {
        throw new PRStateError(
          ErrorCode.PR_HAS_CONFLICTS,
          prNumber,
          'Merge conflict detected'
        );
      }
    }
    throw error;
  }
}

/**
 * Check if a PR needs rebase (is behind base branch)
 */
export function needsRebase(pr: PullRequest): boolean {
  return (
    pr.mergeableState === 'behind' ||
    pr.mergeableState === 'dirty' ||
    pr.mergeable === false
  );
}

/**
 * Validate PR state before processing
 */
export interface PRValidation {
  valid: boolean;
  reason?: string;
}

export function validatePRState(pr: PullRequest): PRValidation {
  if (pr.merged) {
    return { valid: false, reason: 'PR was already merged' };
  }

  if (pr.state === 'closed') {
    return { valid: false, reason: 'PR was closed' };
  }

  if (pr.draft) {
    return { valid: false, reason: 'PR is still in draft' };
  }

  if (pr.mergeableState === 'dirty') {
    return { valid: false, reason: 'PR has merge conflicts' };
  }

  return { valid: true };
}
