/**
 * Renovate PR detection
 */

import type { PullRequest } from '../github/types.js';

const RENOVATE_IDENTIFIERS = [
  'renovate[bot]',
  'renovate-bot',
  'renovatebot',
  'renovate',
];

const RENOVATE_BRANCH_PATTERNS = [
  /^renovate\//i,
  /^renovatebot\//i,
];

/**
 * Check if a PR is from Renovate
 */
export function isRenovatePR(pr: PullRequest): boolean {
  // Check author
  const authorLogin = pr.user?.login?.toLowerCase() ?? '';
  if (RENOVATE_IDENTIFIERS.some((id) => authorLogin.includes(id))) {
    return true;
  }

  // Check branch name
  const branchName = pr.head.ref;
  if (RENOVATE_BRANCH_PATTERNS.some((pattern) => pattern.test(branchName))) {
    return true;
  }

  // Check for Renovate-specific labels
  const labels = pr.labels.map((l) => l.name.toLowerCase());
  if (labels.includes('renovate') || labels.includes('dependencies')) {
    // "dependencies" alone might not be Renovate, but combined with branch pattern it's likely
    if (branchName.toLowerCase().includes('renovate')) {
      return true;
    }
  }

  return false;
}

/**
 * Filter PRs to only include Renovate PRs
 */
export function filterRenovatePRs(prs: PullRequest[]): PullRequest[] {
  return prs.filter(isRenovatePR);
}

/**
 * Extract dependency info from PR title (best effort)
 */
export interface DependencyInfo {
  packageName: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  updateType: 'major' | 'minor' | 'patch' | 'digest' | 'unknown';
}

const UPDATE_TITLE_PATTERNS = [
  // "Update package to v1.2.3"
  /^Update\s+(.+?)\s+to\s+v?(\d+\.\d+\.\d+)/i,
  // "chore(deps): update package from 1.0.0 to 1.2.3"
  /update\s+(.+?)\s+from\s+v?(\d+\.\d+\.\d+)\s+to\s+v?(\d+\.\d+\.\d+)/i,
  // "fix(deps): bump package from 1.0.0 to 1.2.3"
  /bump\s+(.+?)\s+from\s+v?(\d+\.\d+\.\d+)\s+to\s+v?(\d+\.\d+\.\d+)/i,
];

export function extractDependencyInfo(title: string): DependencyInfo {
  for (const pattern of UPDATE_TITLE_PATTERNS) {
    const match = title.match(pattern);
    if (match) {
      const packageName = match[1];
      const fromVersion = match[2] || null;
      const toVersion = match[3] || match[2] || null;

      // Determine update type based on semver
      let updateType: DependencyInfo['updateType'] = 'unknown';
      if (fromVersion && toVersion) {
        const [fromMajor, fromMinor] = fromVersion.split('.').map(Number);
        const [toMajor, toMinor] = toVersion.split('.').map(Number);

        if (toMajor > fromMajor) {
          updateType = 'major';
        } else if (toMinor > fromMinor) {
          updateType = 'minor';
        } else {
          updateType = 'patch';
        }
      }

      return {
        packageName,
        fromVersion,
        toVersion,
        updateType,
      };
    }
  }

  // Check for digest updates
  if (title.toLowerCase().includes('digest')) {
    return {
      packageName: null,
      fromVersion: null,
      toVersion: null,
      updateType: 'digest',
    };
  }

  return {
    packageName: null,
    fromVersion: null,
    toVersion: null,
    updateType: 'unknown',
  };
}
