/**
 * GitHub-related type definitions
 */

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  htmlUrl: string;
  user: {
    login: string;
  } | null;
  head: {
    sha: string;
    ref: string;
  };
  base: {
    ref: string;
  };
  labels: Array<{
    name: string;
  }>;
}

export interface ChecksStatus {
  state: 'pending' | 'success' | 'failure' | 'error';
  total: number;
  completed: number;
  successful: number;
  failed: number;
  pending: number;
  details: CheckDetail[];
}

export interface CheckDetail {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
}

export interface ReviewInfo {
  hasApproval: boolean;
  approvedBy: string[];
  changesRequested: boolean;
  changesRequestedBy: string[];
}

export interface MergeResult {
  sha: string;
  merged: boolean;
  message: string;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';
