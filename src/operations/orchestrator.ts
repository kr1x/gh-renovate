/**
 * Main orchestrator for the merge workflow
 */

import type { GitHubClient } from '../github/client.js';
import type { PullRequest, ChecksStatus, MergeMethod } from '../github/types.js';
import { getPullRequest, mergePullRequest, validatePRState, needsRebase } from '../github/pulls.js';
import { getChecksStatus, areChecksPassing, areChecksPending, areChecksFailing, formatFailedChecks } from '../github/checks.js';
import { getReviewInfo, approvePullRequest } from '../github/reviews.js';
import { triggerRebase, hasNewCommitSince } from '../renovate/rebase.js';
import { poll, sleep, formatDuration, createCICheckPollerOptions, createRebasePollerOptions } from '../utils/poller.js';
import { UIController, type MergeResultSummary } from '../cli/ui.js';
import { isGhRenovateError } from '../errors/types.js';

export interface OrchestratorOptions {
  /** Timeout for CI checks in ms (default: 10 minutes) */
  checkTimeoutMs: number;
  /** Timeout for rebase in ms (default: 5 minutes) */
  rebaseTimeoutMs: number;
  /** Merge method (default: squash) */
  mergeMethod: MergeMethod;
  /** Continue processing after a PR fails */
  continueOnError: boolean;
  /** Dry run mode - no changes will be made */
  dryRun: boolean;
}

const DEFAULT_OPTIONS: OrchestratorOptions = {
  checkTimeoutMs: 10 * 60 * 1000,
  rebaseTimeoutMs: 5 * 60 * 1000,
  mergeMethod: 'squash',
  continueOnError: true,
  dryRun: false,
};

export interface OrchestratorResult {
  processed: number;
  merged: number;
  skipped: number;
  failed: number;
  results: MergeResultSummary[];
  dryRun: boolean;
}

/**
 * Process a single PR through the merge workflow
 */
async function processSinglePR(
  client: GitHubClient,
  owner: string,
  repo: string,
  pr: PullRequest,
  ui: UIController,
  options: OrchestratorOptions
): Promise<MergeResultSummary> {
  const result: MergeResultSummary = {
    prNumber: pr.number,
    title: pr.title,
    status: 'failed',
  };

  try {
    // Step 1: Get fresh PR data
    ui.updateStatus('Fetching latest PR data...');
    let freshPR = await getPullRequest(client, owner, repo, pr.number);

    // Step 2: Validate PR state
    const validation = validatePRState(freshPR);
    if (!validation.valid) {
      result.status = 'skipped';
      result.reason = validation.reason;
      return result;
    }

    // Step 3: Check CI status
    ui.updateStatus('Checking CI status...');
    let checksStatus = await getChecksStatus(client, owner, repo, freshPR.head.sha);

    // If checks are failing, skip
    if (areChecksFailing(checksStatus)) {
      result.status = 'skipped';
      result.reason = `CI checks failed: ${formatFailedChecks(checksStatus)}`;
      return result;
    }

    // If checks are pending, wait
    if (areChecksPending(checksStatus)) {
      ui.updateStatus('Waiting for CI checks...');

      checksStatus = await poll<ChecksStatus>(
        () => getChecksStatus(client, owner, repo, freshPR.head.sha),
        {
          ...createCICheckPollerOptions(
            (status) => {
              if (areChecksFailing(status)) return 'done';
              if (areChecksPassing(status)) return 'done';
              return 'continue';
            },
            (status, elapsed) => {
              ui.updateStatus(
                `Waiting for CI: ${status.successful}/${status.total} passed (${formatDuration(elapsed)})`
              );
            }
          ),
          timeoutMs: options.checkTimeoutMs,
        }
      );

      if (areChecksFailing(checksStatus)) {
        result.status = 'skipped';
        result.reason = `CI checks failed: ${formatFailedChecks(checksStatus)}`;
        return result;
      }
    }

    // Step 4: Check approval status
    ui.updateStatus('Checking review status...');
    const reviewInfo = await getReviewInfo(client, owner, repo, pr.number);

    if (!reviewInfo.hasApproval) {
      if (options.dryRun) {
        ui.updateStatus('[DRY-RUN] Would approve PR...');
      } else {
        ui.updateStatus('Approving PR...');
        await approvePullRequest(client, owner, repo, pr.number);
      }
    }

    // Step 5: Handle rebase if needed
    freshPR = await getPullRequest(client, owner, repo, pr.number);

    if (needsRebase(freshPR)) {
      if (options.dryRun) {
        ui.updateStatus('[DRY-RUN] Would trigger rebase...');
        // In dry-run mode, we skip waiting for rebase since we didn't trigger it
      } else {
        ui.updateStatus('Triggering rebase...');
        const previousSha = freshPR.head.sha;
        const method = await triggerRebase(client, owner, repo, freshPR);
        ui.updateStatus(`Rebase triggered via ${method}, waiting...`);

        // Wait for Renovate to push a new commit
        await poll<{ hasNewCommit: boolean; currentSha: string }>(
          () => hasNewCommitSince(client, owner, repo, pr.number, previousSha),
          {
            ...createRebasePollerOptions(
              (pollResult) => (pollResult.hasNewCommit ? 'done' : 'continue'),
              (_, elapsed) => {
                ui.updateStatus(`Waiting for rebase (${formatDuration(elapsed)})`);
              }
            ),
            timeoutMs: options.rebaseTimeoutMs,
          }
        );

        // Wait a moment for GitHub to update PR state
        await sleep(3000);

        // Get new PR data after rebase
        freshPR = await getPullRequest(client, owner, repo, pr.number);

        // Wait for CI checks on the new commit
        ui.updateStatus('Waiting for CI after rebase...');

        checksStatus = await poll<ChecksStatus>(
          () => getChecksStatus(client, owner, repo, freshPR.head.sha),
          {
            ...createCICheckPollerOptions(
              (status) => {
                if (areChecksFailing(status)) return 'done';
                if (areChecksPassing(status)) return 'done';
                return 'continue';
              },
              (status, elapsed) => {
                ui.updateStatus(
                  `Waiting for CI after rebase: ${status.successful}/${status.total} passed (${formatDuration(elapsed)})`
                );
              }
            ),
            timeoutMs: options.checkTimeoutMs,
          }
        );

        if (areChecksFailing(checksStatus)) {
          result.status = 'skipped';
          result.reason = `CI checks failed after rebase: ${formatFailedChecks(checksStatus)}`;
          return result;
        }
      }
    }

    // Step 6: Final check before merge - PR might be behind after previous merges
    ui.updateStatus('Final merge check...');
    freshPR = await getPullRequest(client, owner, repo, pr.number);

    if (needsRebase(freshPR)) {
      if (options.dryRun) {
        ui.updateStatus('[DRY-RUN] Would trigger rebase (PR is behind)...');
      } else {
        ui.updateStatus('PR is behind, triggering rebase...');
        const previousSha = freshPR.head.sha;
        const method = await triggerRebase(client, owner, repo, freshPR);
        ui.updateStatus(`Rebase triggered via ${method}, waiting...`);

        await poll<{ hasNewCommit: boolean; currentSha: string }>(
          () => hasNewCommitSince(client, owner, repo, pr.number, previousSha),
          {
            ...createRebasePollerOptions(
              (pollResult) => (pollResult.hasNewCommit ? 'done' : 'continue'),
              (_, elapsed) => {
                ui.updateStatus(`Waiting for rebase (${formatDuration(elapsed)})`);
              }
            ),
            timeoutMs: options.rebaseTimeoutMs,
          }
        );

        await sleep(3000);
        freshPR = await getPullRequest(client, owner, repo, pr.number);

        ui.updateStatus('Waiting for CI after rebase...');
        checksStatus = await poll<ChecksStatus>(
          () => getChecksStatus(client, owner, repo, freshPR.head.sha),
          {
            ...createCICheckPollerOptions(
              (status) => {
                if (areChecksFailing(status)) return 'done';
                if (areChecksPassing(status)) return 'done';
                return 'continue';
              },
              (status, elapsed) => {
                ui.updateStatus(
                  `Waiting for CI after rebase: ${status.successful}/${status.total} passed (${formatDuration(elapsed)})`
                );
              }
            ),
            timeoutMs: options.checkTimeoutMs,
          }
        );

        if (areChecksFailing(checksStatus)) {
          result.status = 'skipped';
          result.reason = `CI checks failed after rebase: ${formatFailedChecks(checksStatus)}`;
          return result;
        }
      }
    }

    // Step 7: Merge!
    if (options.dryRun) {
      ui.updateStatus('[DRY-RUN] Would merge PR...');
    } else {
      ui.updateStatus('Merging...');
      await mergePullRequest(client, owner, repo, pr.number, {
        mergeMethod: options.mergeMethod,
      });
    }

    result.status = 'merged';
    return result;
  } catch (error) {
    result.status = 'failed';
    if (isGhRenovateError(error)) {
      result.reason = error.userMessage;
    } else if (error instanceof Error) {
      result.reason = error.message;
    } else {
      result.reason = 'Unknown error';
    }
    return result;
  }
}

/**
 * Orchestrate the merge workflow for multiple PRs
 */
export async function orchestrateMerge(
  client: GitHubClient,
  owner: string,
  repo: string,
  prs: PullRequest[],
  options: Partial<OrchestratorOptions> = {},
  onAskContinue?: (prNumber: number, reason: string) => Promise<boolean>
): Promise<OrchestratorResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const ui = new UIController();
  const results: MergeResultSummary[] = [];

  for (let i = 0; i < prs.length; i++) {
    const pr = prs[i];
    const position = `[${i + 1}/${prs.length}]`;

    ui.startPR(pr, position);

    const result = await processSinglePR(client, owner, repo, pr, ui, opts);
    results.push(result);

    // Update UI based on result
    switch (result.status) {
      case 'merged':
        ui.completePR(pr, opts.dryRun);
        break;
      case 'skipped':
        ui.skipPR(pr, result.reason ?? 'Unknown reason');
        break;
      case 'failed':
        ui.failPR(pr, result.reason ?? 'Unknown error');
        break;
    }

    // Handle non-merged PRs
    if (result.status !== 'merged') {
      if (!opts.continueOnError) {
        // Stop processing
        break;
      }

      // Ask user if they want to continue (if callback provided)
      if (onAskContinue) {
        const shouldContinue = await onAskContinue(pr.number, result.reason ?? 'Unknown');
        if (!shouldContinue) {
          break;
        }
      }
    }

    // Small delay between PRs to be nice to the API and let GitHub process
    if (i < prs.length - 1 && result.status === 'merged') {
      await sleep(3000);
    }
  }

  // Calculate summary
  const merged = results.filter((r) => r.status === 'merged').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  return {
    processed: results.length,
    merged,
    skipped,
    failed,
    results,
    dryRun: opts.dryRun,
  };
}
