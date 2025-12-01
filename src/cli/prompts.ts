/**
 * CLI prompts for user interaction
 */

import { checkbox, confirm, input, password } from '@inquirer/prompts';
import type { PullRequest } from '../github/types.js';
import type { ChecksStatus } from '../github/types.js';
import { formatPRChoice, formatChecksStatus } from './ui.js';

/**
 * Prompt for GitHub token
 */
export async function promptForToken(): Promise<string> {
  return password({
    message: 'Enter GitHub token (needs repo scope):',
    mask: '*',
  });
}

/**
 * Prompt for repository URL
 */
export async function promptForRepoUrl(): Promise<string> {
  return input({
    message: 'Enter GitHub repository URL (e.g., owner/repo):',
    validate: (value) => {
      if (!value.trim()) {
        return 'Repository URL is required';
      }
      return true;
    },
  });
}

/**
 * PR with optional status info for display
 */
export interface PRWithStatus {
  pr: PullRequest;
  checksStatus?: ChecksStatus;
}

/**
 * Prompt user to select PRs to merge
 */
export async function promptForPRSelection(
  prs: PRWithStatus[]
): Promise<PullRequest[]> {
  const choices = prs.map(({ pr, checksStatus }) => {
    const statusStr = checksStatus
      ? formatChecksStatus(checksStatus.state, checksStatus.completed, checksStatus.total)
      : undefined;

    return {
      name: formatPRChoice(pr, statusStr),
      value: pr,
      checked: false,
    };
  });

  const selected = await checkbox({
    message: 'Select PRs to merge (selection order = merge order):',
    choices,
    required: false,
  });

  return selected;
}

/**
 * Prompt for confirmation before merging
 */
export async function promptForMergeConfirmation(
  prs: PullRequest[]
): Promise<boolean> {
  console.log('\nSelected PRs (will be merged in this order):');
  prs.forEach((pr, i) => {
    console.log(`  ${i + 1}. #${pr.number} - ${pr.title}`);
  });
  console.log('');

  return confirm({
    message: `Proceed with merging ${prs.length} PR(s)?`,
    default: true,
  });
}

/**
 * Prompt to continue after a PR fails
 */
export async function promptToContinueAfterFailure(
  prNumber: number,
  reason: string
): Promise<boolean> {
  return confirm({
    message: `PR #${prNumber} was not merged (${reason}). Continue with remaining PRs?`,
    default: true,
  });
}

/**
 * Prompt to retry a failed operation
 */
export async function promptToRetry(operation: string): Promise<boolean> {
  return confirm({
    message: `${operation} failed. Retry?`,
    default: true,
  });
}
