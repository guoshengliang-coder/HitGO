#!/usr/bin/env bash
# Clean up after a task branch has been merged: remove its worktree, delete the
# local branch, prune the remote-tracking branch. Refuses if the PR is not merged.
#
# Usage: scripts/task-done.sh feat/<task>            (run from the main checkout)
set -euo pipefail

branch="${1:?usage: task-done.sh <branch>}"
cd "$(dirname "$0")/.."

[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "run this from the main checkout"; exit 1; }

state="$(gh pr view "$branch" --json state -q .state 2>/dev/null || echo NONE)"
if [ "$state" != "MERGED" ]; then
  echo "PR for $branch is $state — only merged branches are cleaned up"; exit 1
fi

git fetch -q --prune origin
git pull -q --ff-only origin main

wt="$(git worktree list --porcelain | awk -v b="refs/heads/$branch" '$1=="worktree"{p=$2} $1=="branch"&&$2==b{print p}')"
if [ -n "$wt" ]; then
  git worktree remove --force "$wt" && echo "removed worktree $wt"
fi
git branch -D "$branch" >/dev/null 2>&1 && echo "deleted local branch $branch" || true
git worktree prune
echo "done: $branch cleaned up, main at $(git rev-parse --short HEAD)"
