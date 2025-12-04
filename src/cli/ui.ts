/**
 * CLI UI utilities - spinners and status display
 */

import ora, { type Ora } from 'ora';
import chalk from 'chalk';
import type { PullRequest } from '../github/types.js';

/**
 * UI Controller for managing spinners and status output
 */
export class UIController {
  private spinner: Ora;
  private currentPR?: PullRequest;
  private position?: string;

  constructor() {
    this.spinner = ora();
  }

  /**
   * Start processing a PR
   */
  startPR(pr: PullRequest, position: string): void {
    this.currentPR = pr;
    this.position = position;
    this.spinner.start(
      chalk.blue(`${position} Processing #${pr.number}: ${pr.title}`)
    );
  }

  /**
   * Update the current status message
   */
  updateStatus(status: string): void {
    if (this.currentPR && this.position) {
      this.spinner.text = chalk.blue(
        `${this.position} #${this.currentPR.number}: ${status}`
      );
    }
  }

  /**
   * Mark PR as successfully completed
   */
  completePR(pr: PullRequest, dryRun = false): void {
    if (dryRun) {
      this.spinner.succeed(
        chalk.cyan(`#${pr.number}: [DRY-RUN] Would be merged`)
      );
    } else {
      this.spinner.succeed(
        chalk.green(`#${pr.number}: Merged successfully`)
      );
    }
    this.currentPR = undefined;
  }

  /**
   * Mark PR as skipped
   */
  skipPR(pr: PullRequest, reason: string): void {
    this.spinner.warn(
      chalk.yellow(`#${pr.number}: Skipped - ${reason}`)
    );
    this.currentPR = undefined;
  }

  /**
   * Mark PR as failed
   */
  failPR(pr: PullRequest, reason: string): void {
    this.spinner.fail(
      chalk.red(`#${pr.number}: Failed - ${reason}`)
    );
    this.currentPR = undefined;
  }

  /**
   * Mark PR as deferred for retry later
   */
  deferPR(pr: PullRequest, reason: string): void {
    this.spinner.info(
      chalk.cyan(`#${pr.number}: Deferred - ${reason} (will retry)`)
    );
    this.currentPR = undefined;
  }

  /**
   * Show an info message
   */
  info(message: string): void {
    this.spinner.info(chalk.blue(message));
  }

  /**
   * Show a success message
   */
  success(message: string): void {
    this.spinner.succeed(chalk.green(message));
  }

  /**
   * Show a warning message
   */
  warn(message: string): void {
    this.spinner.warn(chalk.yellow(message));
  }

  /**
   * Show an error message
   */
  error(message: string): void {
    this.spinner.fail(chalk.red(message));
  }

  /**
   * Stop the spinner
   */
  stop(): void {
    this.spinner.stop();
  }

  /**
   * Get the spinner instance (for polling operations)
   */
  get currentSpinner(): Ora {
    return this.spinner;
  }
}

/**
 * Format a PR for display in the selection list
 */
export function formatPRChoice(pr: PullRequest, checksStatus?: string): string {
  const parts = [`#${pr.number}`, pr.title];

  if (checksStatus) {
    parts.push(chalk.dim(`[${checksStatus}]`));
  }

  if (pr.draft) {
    parts.push(chalk.yellow('(draft)'));
  }

  return parts.join(' ');
}

/**
 * Format checks status for display
 */
export function formatChecksStatus(
  state: 'pending' | 'success' | 'failure' | 'error',
  completed: number,
  total: number
): string {
  switch (state) {
    case 'success':
      return chalk.green(`${completed}/${total} passed`);
    case 'failure':
    case 'error':
      return chalk.red(`${completed}/${total} failed`);
    case 'pending':
      return chalk.yellow(`${completed}/${total} pending`);
    default:
      return chalk.dim('unknown');
  }
}

/**
 * Print a summary of the merge operation
 */
export interface MergeResultSummary {
  prNumber: number;
  title: string;
  status: 'merged' | 'skipped' | 'failed';
  reason?: string;
}

export function printSummary(results: MergeResultSummary[], dryRun = false): void {
  if (dryRun) {
    console.log('\n' + chalk.bold.cyan('─── Summary (DRY-RUN) ───'));
  } else {
    console.log('\n' + chalk.bold('─── Summary ───'));
  }

  const merged = results.filter((r) => r.status === 'merged');
  const skipped = results.filter((r) => r.status === 'skipped');
  const failed = results.filter((r) => r.status === 'failed');

  if (dryRun) {
    console.log(chalk.cyan(`Would merge: ${merged.length}`));
    for (const r of merged) {
      console.log(chalk.cyan(`  ○ #${r.prNumber}: ${r.title}`));
    }
  } else {
    console.log(chalk.green(`Merged: ${merged.length}`));
    for (const r of merged) {
      console.log(chalk.green(`  ✓ #${r.prNumber}: ${r.title}`));
    }
  }

  if (skipped.length > 0) {
    console.log(chalk.yellow(`Skipped: ${skipped.length}`));
    for (const r of skipped) {
      console.log(chalk.yellow(`  ○ #${r.prNumber}: ${r.reason}`));
    }
  }

  if (failed.length > 0) {
    console.log(chalk.red(`Failed: ${failed.length}`));
    for (const r of failed) {
      console.log(chalk.red(`  ✗ #${r.prNumber}: ${r.reason}`));
    }
  }

  console.log('');
}

/**
 * Print a header
 */
export function printHeader(text: string): void {
  console.log(chalk.bold.blue(`\n${text}\n`));
}

/**
 * Print repo info
 */
export function printRepoInfo(owner: string, repo: string): void {
  console.log(chalk.dim(`Repository: ${owner}/${repo}\n`));
}
