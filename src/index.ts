#!/usr/bin/env node

/**
 * gh-renovate - Interactive CLI for batch-merging Renovate PRs
 */

import chalk from 'chalk';
import { createGitHubClient, getGitHubTokenFromEnv, validateToken } from './github/client.js';
import { listOpenPullRequests } from './github/pulls.js';
import { getChecksStatus } from './github/checks.js';
import { filterRenovatePRs } from './renovate/detector.js';
import { parseRepoUrl } from './utils/url-parser.js';
import { orchestrateMerge } from './operations/orchestrator.js';
import {
  promptForToken,
  promptForRepoUrl,
  promptForPRSelection,
  promptForMergeConfirmation,
  promptToContinueAfterFailure,
  type PRWithStatus,
} from './cli/prompts.js';
import { printHeader, printRepoInfo, printSummary } from './cli/ui.js';
import { isGhRenovateError } from './errors/types.js';
import type { MergeMethod } from './github/types.js';

/**
 * Parse CLI arguments
 */
function parseArgs(): { repoUrl?: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let repoUrl: string | undefined;
  let dryRun = false;

  for (const arg of args) {
    if (arg === '--dry-run' || arg === '-n') {
      dryRun = true;
    } else if (!arg.startsWith('-')) {
      repoUrl = arg;
    }
  }

  return { repoUrl, dryRun };
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const { repoUrl: repoUrlArg, dryRun } = parseArgs();

  if (dryRun) {
    printHeader('gh-renovate - Renovate PR Merger [DRY-RUN]');
    console.log(chalk.cyan('Running in dry-run mode - no changes will be made.\n'));
  } else {
    printHeader('gh-renovate - Renovate PR Merger');
  }

  try {
    // Step 1: Get GitHub token
    let token: string;
    try {
      token = getGitHubTokenFromEnv();
    } catch {
      // No token in env, prompt for it
      console.log(chalk.dim('No GITHUB_TOKEN found in environment.\n'));
      token = await promptForToken();
    }

    // Step 2: Create and validate client
    const client = createGitHubClient({
      token,
      onRateLimit: (retryAfter) => {
        console.log(chalk.yellow(`\nRate limit hit. Waiting ${retryAfter}s...`));
      },
    });

    console.log(chalk.dim('Validating token...'));
    await validateToken(client);
    console.log(chalk.green('Token validated.\n'));

    // Step 3: Get repository URL
    const repoUrl = repoUrlArg || await promptForRepoUrl();
    const { owner, repo } = parseRepoUrl(repoUrl);
    printRepoInfo(owner, repo);

    // Step 4: Fetch open PRs
    console.log(chalk.dim('Fetching open pull requests...'));
    const allPRs = await listOpenPullRequests(client, owner, repo);

    // Step 5: Filter to Renovate PRs
    const renovatePRs = filterRenovatePRs(allPRs);

    if (renovatePRs.length === 0) {
      console.log(chalk.yellow('No open Renovate PRs found.'));
      return;
    }

    console.log(chalk.green(`Found ${renovatePRs.length} Renovate PR(s).\n`));

    // Step 6: Fetch check status for each PR (for display)
    console.log(chalk.dim('Fetching CI status for PRs...'));
    const prsWithStatus: PRWithStatus[] = [];

    for (const pr of renovatePRs) {
      const checksStatus = await getChecksStatus(client, owner, repo, pr.head.sha);
      prsWithStatus.push({ pr, checksStatus });
    }

    // Step 7: Prompt for PR selection
    const selectedPRs = await promptForPRSelection(prsWithStatus);

    if (selectedPRs.length === 0) {
      console.log(chalk.yellow('No PRs selected.'));
      return;
    }

    // Step 8: Confirm
    const confirmed = await promptForMergeConfirmation(selectedPRs);

    if (!confirmed) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }

    // Step 9: Run the orchestrator
    console.log(''); // Empty line before processing starts

    const result = await orchestrateMerge(
      client,
      owner,
      repo,
      selectedPRs,
      {
        mergeMethod: 'squash' as MergeMethod,
        continueOnError: true,
        checkTimeoutMs: 10 * 60 * 1000,
        rebaseTimeoutMs: 5 * 60 * 1000,
        dryRun,
      },
      promptToContinueAfterFailure
    );

    // Step 10: Print summary
    printSummary(result.results, result.dryRun);

    // Exit with error code if any failed
    if (result.failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    if (isGhRenovateError(error)) {
      console.error(chalk.red(`\nError: ${error.userMessage}`));
    } else if (error instanceof Error) {
      console.error(chalk.red(`\nError: ${error.message}`));
    } else {
      console.error(chalk.red('\nAn unexpected error occurred.'));
    }
    process.exit(1);
  }
}

// Run
main();
