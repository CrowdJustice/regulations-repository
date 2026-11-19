#!/usr/bin/env bash
# Saves this run's commits to GitHub.
#
#   bash agent/push.sh ours|theirs
#
# The daily check and an admin action can finish at the same moment. When that happens the other side's commits
# are merged in first. If both changed the same lines, "ours" keeps this run's version and "theirs" keeps the other's.
# An admin action uses "ours" and the daily check uses "theirs", so the admin always wins.
set -euo pipefail
prefer="${1:-theirs}"
branch="$(git rev-parse --abbrev-ref HEAD)"
for attempt in 1 2 3 4 5; do
  if git push -q origin "HEAD:${branch}"; then exit 0; fi
  if ! git pull -q --no-rebase --no-edit -X "${prefer}" origin "${branch}"; then
    git merge --abort 2>/dev/null || true
  fi
  sleep $((attempt * 2))
done
echo "::error::The changes could not be saved to the repository. Run it again."
exit 1
