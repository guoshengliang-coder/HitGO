#!/usr/bin/env bash
# Tag a release from main and push the tag (deploy.yml takes it from there).
# Usage: scripts/release.sh v0.2.0
set -euo pipefail

version="${1:?usage: release.sh vX.Y.Z}"
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must look like v0.2.0"; exit 1; }

cd "$(dirname "$0")/.."
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || { echo "release only from main (current: $branch)"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }

git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "local main differs from origin/main — pull or push first"; exit 1; }

prev="$(git describe --tags --abbrev=0 2>/dev/null || true)"
echo "==> changes since ${prev:-repository start}:"
git log --oneline "${prev:+$prev..}HEAD" | sed 's/^/    /'

git tag -a "$version" -m "HitGO $version"
git push origin "$version"
echo "==> pushed $version — the Deploy workflow will build and deploy it"
