/**
 * Main orchestrator for the merge workflow
 */

import type { GitHubClient } from '../github/client.js';
import type { PullRequest, ChecksStatus, MergeMethod } from '../github/types.js';
import { getPullRequest, mergePullRequest, validatePRState, needsRebase } from '../github/pulls.js';
import {
  getChecksStatus,
  areChecksPassing,
  areChecksPending,
  areChecksFailing,
  formatFailedChecks,
  hasStabilityDaysPending,
} from '../github/checks.js';
import { MergeBlockedError } from '../errors/types.js';
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

/** Maximum retries for the entire PR processing (fail-safe) */
const MAX_PROCESS_RETRIES = 3;

/**
 * Wait for CI checks to complete
 */
async function waitForChecks(
  client: GitHubClient,
  owner: string,
  repo: string,
  sha: string,
  ui: UIController,
  timeoutMs: number,
  statusPrefix: string = 'Waiting for CI'
): Promise<{ status: ChecksStatus; passed: boolean }> {
  const checksStatus = await poll<ChecksStatus>(
    () => getChecksStatus(client, owner, repo, sha),
    {
      ...createCICheckPollerOptions(
        (status) => {
          if (areChecksFailing(status)) return 'done';
          if (areChecksPassing(status)) return 'done';
          return 'continue';
        },
        (status, elapsed) => {
          ui.updateStatus(
            `${statusPrefix}: ${status.successful}/${status.total} passed (${formatDuration(elapsed)})`
          );
        }
      ),
      timeoutMs,
    }
  );

  return {
    status: checksStatus,
    passed: areChecksPassing(checksStatus),
  };
}

/**
 * Process a single PR through the merge workflow
 * Includes fail-safe retry logic - if something goes wrong, starts over
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

  // Fail-safe retry loop - if anything goes wrong, start over
  for (let attempt = 1; attempt <= MAX_PROCESS_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        ui.updateStatus(`Retrying from start (attempt ${attempt}/${MAX_PROCESS_RETRIES})...`);
        await sleep(2000); // Brief pause before retry
      }

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

      // If checks are failing, skip (not retriable)
      if (areChecksFailing(checksStatus)) {
        result.status = 'skipped';
        result.reason = `CI checks failed: ${formatFailedChecks(checksStatus)}`;
        return result;
      }

      // Skip PRs with stability-days pending - these need to wait
      if (hasStabilityDaysPending(checksStatus)) {
        result.status = 'skipped';
        result.reason = 'Waiting for stability-days (skipped)';
        return result;
      }

      // If there are pending checks, wait for them
      if (areChecksPending(checksStatus)) {
        ui.updateStatus('Waiting for CI checks...');
        const checkResult = await waitForChecks(
          client, owner, repo, freshPR.head.sha, ui, options.checkTimeoutMs
        );
        checksStatus = checkResult.status;

        if (!checkResult.passed) {
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

          await sleep(3000);
          freshPR = await getPullRequest(client, owner, repo, pr.number);

          // Wait for CI checks on the new commit
          const checkResult = await waitForChecks(
            client, owner, repo, freshPR.head.sha, ui, options.checkTimeoutMs, 'Waiting for CI after rebase'
          );
          checksStatus = checkResult.status;

          if (!checkResult.passed) {
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

          const checkResult = await waitForChecks(
            client, owner, repo, freshPR.head.sha, ui, options.checkTimeoutMs, 'Waiting for CI after rebase'
          );
          checksStatus = checkResult.status;

          if (!checkResult.passed) {
            result.status = 'skipped';
            result.reason = `CI checks failed after rebase: ${formatFailedChecks(checksStatus)}`;
            return result;
          }
        }
      }

      // Step 7: Merge with retry logic for late-starting checks
      if (options.dryRun) {
        ui.updateStatus('[DRY-RUN] Would merge PR...');
        result.status = 'merged';
        return result;
      }

      // Merge attempt loop (for late-starting checks)
      const maxMergeRetries = 3;
      for (let mergeAttempt = 1; mergeAttempt <= maxMergeRetries; mergeAttempt++) {
        ui.updateStatus(mergeAttempt > 1 ? `Merging (attempt ${mergeAttempt})...` : 'Merging...');

        try {
          await mergePullRequest(client, owner, repo, pr.number, {
            mergeMethod: options.mergeMethod,
          });
          result.status = 'merged';
          return result;
        } catch (mergeError) {
          if (mergeError instanceof MergeBlockedError) {
            ui.updateStatus('Merge blocked, re-evaluating PR state...');

            // Re-fetch everything and check what's wrong
            freshPR = await getPullRequest(client, owner, repo, pr.number);

            // Check if PR was merged/closed in the meantime
            if (freshPR.merged) {
              result.status = 'merged';
              result.reason = 'PR was already merged';
              return result;
            }
            if (freshPR.state === 'closed') {
              result.status = 'skipped';
              result.reason = 'PR was closed';
              return result;
            }

            checksStatus = await getChecksStatus(client, owner, repo, freshPR.head.sha);

            // If stability-days appeared, skip
            if (hasStabilityDaysPending(checksStatus)) {
              result.status = 'skipped';
              result.reason = 'Waiting for stability-days (skipped)';
              return result;
            }

            // Check for new pending checks
            if (areChecksPending(checksStatus)) {
              ui.updateStatus('New checks detected, waiting...');
              const checkResult = await waitForChecks(
                client, owner, repo, freshPR.head.sha, ui, options.checkTimeoutMs, 'Waiting for late checks'
              );

              if (!checkResult.passed) {
                result.status = 'skipped';
                result.reason = `CI checks failed: ${formatFailedChecks(checkResult.status)}`;
                return result;
              }
              continue; // Retry merge
            }

            // Check if PR needs rebase now
            if (needsRebase(freshPR)) {
              // Throw to trigger outer retry loop - start from beginning
              throw new Error('PR needs rebase after merge attempt');
            }

            // No pending checks, no rebase needed - something else is blocking
            // Don't retry, just throw immediately
            throw mergeError;
          } else {
            throw mergeError;
          }
        }
      }
    } catch (error) {
      // Check if this is a retriable error
      const isRetriable =
        error instanceof MergeBlockedError ||
        (error instanceof Error && error.message.includes('needs rebase'));

      if (isRetriable && attempt < MAX_PROCESS_RETRIES) {
        ui.updateStatus(`Error occurred, will retry: ${error instanceof Error ? error.message : 'Unknown error'}`);
        continue; // Retry from the beginning
      }

      // Non-retriable or max retries reached
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

  return result;
}

/**
 * Reasons that allow a PR to be retried later
 */
function isRetriableReason(reason: string | undefined): boolean {
  if (!reason) return false;
  const lowerReason = reason.toLowerCase();
  // Retriable: CI failures (might pass after rebase), merge blocked, needs rebase
  // Not retriable: stability-days (won't change), already merged, closed
  return (
    lowerReason.includes('ci checks failed') ||
    lowerReason.includes('merge blocked') ||
    lowerReason.includes('needs rebase') ||
    lowerReason.includes('timeout')
  );
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
  _onAskContinue?: (prNumber: number, reason: string) => Promise<boolean>
): Promise<OrchestratorResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const ui = new UIController();
  const results: MergeResultSummary[] = [];

  // Track PRs to retry and which have already been retried
  const deferredPRs: PullRequest[] = [];
  const retriedPRNumbers = new Set<number>();

  // Process all PRs
  const allPRs = [...prs];

  while (allPRs.length > 0) {
    const pr = allPRs.shift()!;
    const isRetry = retriedPRNumbers.has(pr.number);
    const totalCount = prs.length + deferredPRs.filter(p => !retriedPRNumbers.has(p.number)).length;
    const processedCount = results.filter(r => r.status === 'merged').length + 1;
    const position = isRetry ? `[retry]` : `[${processedCount}/${prs.length}]`;

    ui.startPR(pr, position);

    const result = await processSinglePR(client, owner, repo, pr, ui, opts);

    // Update UI based on result
    switch (result.status) {
      case 'merged':
        ui.completePR(pr, opts.dryRun);
        results.push(result);
        break;
      case 'skipped':
      case 'failed':
        // Check if this PR can be retried later
        if (!isRetry && isRetriableReason(result.reason)) {
          ui.deferPR(pr, result.reason ?? 'Unknown reason');
          deferredPRs.push(pr);
        } else {
          if (result.status === 'skipped') {
            ui.skipPR(pr, result.reason ?? 'Unknown reason');
          } else {
            ui.failPR(pr, result.reason ?? 'Unknown error');
          }
          results.push(result);
        }
        break;
    }

    // Small delay between PRs to be nice to the API and let GitHub process
    if (allPRs.length > 0 || deferredPRs.length > 0) {
      await sleep(3000);
    }

    // If we've processed all original PRs, add deferred ones for retry
    if (allPRs.length === 0 && deferredPRs.length > 0) {
      console.log(`\n🔄 Retrying ${deferredPRs.length} deferred PR(s)...\n`);
      for (const deferred of deferredPRs) {
        retriedPRNumbers.add(deferred.number);
        allPRs.push(deferred);
      }
      deferredPRs.length = 0; // Clear deferred list
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
