#!/usr/bin/env bash
# Pull upstream into this fork, verify, and republish the dist branch.
#
# Stops on the first problem: a merge conflict, a failing test, or a failed
# build all exit non-zero and leave the working tree for a human to inspect.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> fetch upstream"
git fetch -q upstream
BEHIND=$(git rev-list --count HEAD..upstream/main)
if [ "$BEHIND" = "0" ]; then
  echo "==> already up to date with upstream/main"
  exit 0
fi
echo "==> $BEHIND upstream commit(s) to merge"
git log --oneline HEAD..upstream/main | head -10

echo "==> merge"
if ! git merge --no-edit upstream/main; then
  echo "!! merge conflict — resolve it, then re-run this script" >&2
  exit 1
fi

echo "==> tests"
npm test

echo "==> publish dist"
./scripts/publish-dist.sh

cat <<'EOF'

==> next steps (they touch the live profile, so they are not automatic)
    cd ~/.dsh/profiles/web
    pnpm update dsh-feishu-plugin
    sudo -n systemctl restart dsh-web
EOF
