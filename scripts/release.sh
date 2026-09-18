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

# Do not create a release tag that is guaranteed to fail the automatic deploy.
# An explicitly planned local fallback can bypass this configuration check.
if [ "${RELEASE_MANUAL_DEPLOY:-0}" != "1" ]; then
  secret_names="$(gh secret list --env prototype --json name)"
  variable_names="$(gh variable list --env prototype --json name)"
  DEPLOY_SECRET_NAMES="$secret_names" DEPLOY_VARIABLE_NAMES="$variable_names" python3 - <<'PY'
import json
import os
import sys

secrets = {entry["name"] for entry in json.loads(os.environ["DEPLOY_SECRET_NAMES"])}
variables = {entry["name"] for entry in json.loads(os.environ["DEPLOY_VARIABLE_NAMES"])}
missing = {"DEPLOY_SSH_KEY", "DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_APP_DIR", "DEPLOY_KNOWN_HOSTS"} - secrets
if "HITGO_PUBLIC_ORIGIN" not in variables:
    missing.add("HITGO_PUBLIC_ORIGIN")
if missing:
    print("prototype deploy configuration missing: " + ", ".join(sorted(missing)), file=sys.stderr)
    print("Configure it before tagging, or use RELEASE_MANUAL_DEPLOY=1 for an intentional local fallback.", file=sys.stderr)
    sys.exit(1)
PY
fi

git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "local main differs from origin/main — pull or push first"; exit 1; }

prev="$(git describe --tags --abbrev=0 2>/dev/null || true)"
echo "==> changes since ${prev:-repository start}:"
git log --oneline "${prev:+$prev..}HEAD" | sed 's/^/    /'

git tag -a "$version" -m "HitGO $version"
git push origin "$version"
echo "==> pushed $version — the Deploy workflow will build and deploy it"
