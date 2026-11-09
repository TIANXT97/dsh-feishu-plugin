#!/usr/bin/env bash
# Publish the built plugin to the `dist` branch of this fork.
#
# The profile installs `github:TIANXT97/dsh-feishu-plugin#dist`, so the branch
# must contain a ready-to-run package: `lib/` built, and no `prepare` script
# (otherwise pnpm would ask to run build scripts on install, and the allowBuilds
# key is pinned to the resolved commit URL, which changes on every push).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
BRANCH=dist
WT="${TMPDIR:-/tmp}/dsh-feishu-dist-worktree"

echo "==> build"
node scripts/build.mjs

echo "==> stage $BRANCH"
rm -rf "$WT"
git worktree add -q --detach "$WT"

cd "$WT"
git checkout -q --orphan "$BRANCH.tmp" 2>/dev/null || git checkout -q -B "$BRANCH.tmp"
git rm -rq --cached . >/dev/null 2>&1 || true
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +

# Runtime files the published package needs.
cp -r "$ROOT/lib" .
mkdir -p locale
cp "$ROOT/locale/"*.json locale/ 2>/dev/null || true
cp "$ROOT/cordis.patch.yml" "$ROOT/icon.svg" "$ROOT/LICENSE" "$ROOT/NOTICE.md" .
[ -f "$ROOT/README.md" ] && cp "$ROOT/README.md" .

# package.json without the prepare/prepublish hooks: the bundle is already here.
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("'"$ROOT"'/package.json", "utf8"));
delete pkg.scripts;
delete pkg.devDependencies;
pkg.dependencies = {};
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
'

git add -A
git commit -q -m "build: dist bundle ($(node -p "require('./package.json').version"))" || echo "==> nothing to publish"
git push -q -f origin "HEAD:$BRANCH"

cd "$ROOT"
git worktree remove --force "$WT" >/dev/null 2>&1 || true
echo "==> pushed $BRANCH"
