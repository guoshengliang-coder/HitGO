#!/usr/bin/env bash
# Deploy the current checkout to a single docker-compose host and verify it.
#
# Env (all have prototype defaults, override for other targets):
#   HITGO_SSH          user@host                (required; or put it in .deploy.env, git-ignored)
#   HITGO_APP_DIR      app dir on the host      (default: /srv/hitgo/app)
#   HITGO_DATA_DIR     data dir on the host     (default: /srv/hitgo/data)
#   HITGO_ACCESS_CODE  access code for smoke    (default: read from host .env)
#   SSH_OPTS           extra ssh options        (e.g. -i ~/.ssh/key)
#   SKIP_SMOKE=1       skip the render smoke test
#   HITGO_PUBLIC_ORIGIN  public HTTPS origin for the verified release receipt
# Usage: scripts/deploy.sh [--notice-origin https://public-origin]
set -euo pipefail

cd "$(dirname "$0")/.."

notice_origin=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --notice-origin)
      [ "$#" -ge 2 ] || { echo "--notice-origin needs a URL" >&2; exit 2; }
      notice_origin="$2"
      shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Local, git-ignored overrides (HITGO_SSH=user@host etc.)
[ -f .deploy.env ] && set -a && . ./.deploy.env && set +a
notice_origin="${notice_origin:-${HITGO_PUBLIC_ORIGIN:-}}"

ssh_target="${HITGO_SSH:?set HITGO_SSH=user@host (or create .deploy.env)}"
app_dir="${HITGO_APP_DIR:-/srv/hitgo/app}"
data_dir="${HITGO_DATA_DIR:-/srv/hitgo/data}"
ssh_opts="${SSH_OPTS:-} -o BatchMode=yes -o ConnectTimeout=15"
# shellcheck disable=SC2086
remote() { ssh $ssh_opts "$ssh_target" "$@"; }

rev="$(git rev-parse HEAD)"
short_rev="$(git rev-parse --short HEAD)"
ver="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
if [ -n "$notice_origin" ] && [ -z "$ver" ]; then
  echo "verified release requires a tag at HEAD" >&2
  exit 1
fi
ver="${ver:-dev-$short_rev}"
echo "==> deploying $short_rev ($ver) to configured host"

if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "working tree has uncommitted changes; refusing to deploy" >&2
  exit 1
fi

# Capture the actual previous server version before any source files are replaced.
before_rev=$(remote "if [ -f '$app_dir/VERSION' ]; then cat '$app_dir/VERSION'; fi")

# 1. sync sources (never the runtime data, env, or build artefacts)
# shellcheck disable=SC2086
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude dist --exclude .venv \
  --exclude /data --exclude __pycache__ --exclude .env \
  --exclude .deploy.env --exclude .private \
  -e "ssh $ssh_opts" ./ "$ssh_target:$app_dir/"

# 2. Build and restart. Check the build's own exit code before showing its log
# tail; filtering the build through a remote pipeline can hide a failed build.
build_log=$(mktemp)
if ! remote "set -e; cd '$app_dir'; ln -sfn '$data_dir' data; test -f .env || { echo 'missing $app_dir/.env'; exit 1; }
  echo '$ver' > frontend/.hitgo-version
  sudo -n env HITGO_BUILD_SHA='$rev' HITGO_BUILD_VERSION='$ver' docker compose build" >"$build_log" 2>&1; then
  tail -n 60 "$build_log" >&2
  rm -f "$build_log"
  exit 1
fi
tail -n 3 "$build_log"
rm -f "$build_log"
remote "set -e; cd '$app_dir'; sudo -n docker compose up -d" 2>&1 | tail -n 2

echo "==> waiting for /api/health"
for _ in $(seq 1 30); do
  code=$(remote "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/api/health || true")
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] || { echo "!!  health check failed ($code)"; remote "cd '$app_dir' && sudo -n docker compose logs --tail=40 api"; exit 1; }
echo "    healthy"
remote "printf '%s\\n' '$rev' > '$app_dir/VERSION'"

# 3. smoke: trim + stickers + two variants through the real ffmpeg pipeline
if [ "${SKIP_SMOKE:-1}" != "1" ]; then
  code_arg="${HITGO_ACCESS_CODE:-\$(grep -E '^ACCESS_CODE=' '$app_dir/.env' | cut -d= -f2)}"
  echo "==> smoke render"
  remote "cd '$app_dir' && timeout 300 python3 scripts/smoke_render.py http://127.0.0.1:8790 $code_arg" | grep -E "batch|finished|done|failed" || { echo "!!  smoke failed"; exit 1; }
fi

echo "==> done: $short_rev deployed"

# Public proof ties the running API and downloaded frontend to the image just built.
# The final stdout line is the machine-readable receipt for MissionGo matching.
if [ -n "$notice_origin" ]; then
  python3 scripts/verify-release.py \
    --origin "$notice_origin" --ssh-target "$ssh_target" \
    --app-dir "$app_dir" --ssh-opts "$ssh_opts" \
    --before "$before_rev" --commit "$rev" --version "$ver"
else
  echo "!! no release receipt: set HITGO_PUBLIC_ORIGIN or --notice-origin" >&2
fi
