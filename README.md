# gh-renovate

Interactive CLI for batch-merging Renovate PRs.

## Problem

Renovate creates PRs for dependency updates on a regular basis. With branch protection rules enabled, the workflow looks like this:

1. Approve PR
2. Merge PR
3. All other Renovate PRs are now "out of date"
4. Check the rebase checkbox in the next PR
5. Wait for Renovate to rebase
6. Wait for CI to pass
7. Approve
8. Merge
9. Back to step 3

This is repetitive and tedious.

## Solution

`gh-renovate` automates this workflow:

1. Lists all open Renovate PRs with CI status
2. You select which PRs to merge
3. The tool processes PRs sequentially:
   - Checks CI status
   - Approves if needed
   - Triggers rebase if needed
   - Waits for CI
   - Merges

## Usage

```bash
# With repo URL
npx gh-renovate owner/repo
npx gh-renovate https://github.com/owner/repo

# Interactive (prompts for URL)
npx gh-renovate

# Dry-run (no changes, shows what would happen)
npx gh-renovate --dry-run owner/repo
npx gh-renovate -n owner/repo
```

### Requirements

- `GITHUB_TOKEN` environment variable with `repo` scope
- Or: token will be prompted interactively

## Disclaimer

**This tool is intended for routine, low-risk dependency updates.**

It does not replace code reviews. Use it for:

- Minor/patch updates of well-known dependencies
- Updates where CI coverage is sufficient
- PRs you would approve anyway

Do **not** use it for:

- Major version updates without prior review
- Security-relevant changes that need attention
- Dependencies you're not familiar with

This tool saves time on mechanical work (approve, wait, merge, repeat). The decision of _which_ PRs to merge is yours.
