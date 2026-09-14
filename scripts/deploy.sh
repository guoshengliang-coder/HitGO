#!/usr/bin/env bash
# Deploy the current checkout to a single docker-compose host, then smoke-test.
#
# Env (all have prototype defaults, override for other targets):
#   HITGO_SSH          user@host                (required; or put it in .deploy.env, git-ignored)
#   HITGO_APP_DIR      app dir on the host      (default: /srv/hitgo/app)
#   HITGO_DATA_DIR     data dir on the host     (default: /srv/hitgo/data)
#   HITGO_ACCESS_CODE  access code for smoke    (default: read from host .env)
#   SSH_OPTS           extra ssh options        (e.g. -i ~/.ssh/key)
#   SKIP_SMOKE=1       skip the render smoke test
set -euo pipefail

cd "$(dirname "$0")/.."

# Local, git-ignored overrides (HITGO_SSH=user@host etc.)
[ -f .deploy.env ] && set -a && . ./.deploy.env && set +a

ssh_target="${HITGO_SSH:?set HITGO_SSH=user@host (or create .deploy.env)}"
app_dir="${HITGO_APP_DIR:-/srv/hitgo/app}"
data_dir="${HITGO_DATA_DIR:-/srv/hitgo/data}"
ssh_opts="${SSH_OPTS:-} -o BatchMode=yes -o ConnectTimeout=15"
# shellcheck disable=SC2086
remote() { ssh $ssh_opts "$ssh_target" "$@"; }

rev="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "==> deploying $rev to $ssh_target:$app_dir"

if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "!!  working tree has uncommitted changes — deploying them anyway (prototype)."
fi

# 1. sync sources (never the runtime data, env, or build artefacts)
# shellcheck disable=SC2086
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude dist --exclude .venv \
  --exclude /data --exclude __pycache__ --exclude .env \
  -e "ssh $ssh_opts" ./ "$ssh_target:$app_dir/"

# 2. build + restart, wait for health
remote "set -e; cd '$app_dir'; ln -sfn '$data_dir' data; test -f .env || { echo 'missing $app_dir/.env'; exit 1; }
  echo '$rev' > VERSION
  sudo -n docker compose build 2>&1 | grep -E 'Built|ERROR' | tail -n 3
  sudo -n docker compose up -d 2>&1 | tail -n 2"

echo "==> waiting for /api/health"
for _ in $(seq 1 30); do
  code=$(remote "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/api/health || true")
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] || { echo "!!  health check failed ($code)"; remote "cd '$app_dir' && sudo -n docker compose logs --tail=40 api"; exit 1; }
echo "    healthy"

# 3. smoke: trim + stickers + two variants through the real ffmpeg pipeline
if [ "${SKIP_SMOKE:-0}" != "1" ]; then
  code_arg="${HITGO_ACCESS_CODE:-\$(grep -E '^ACCESS_CODE=' '$app_dir/.env' | cut -d= -f2)}"
  echo "==> smoke render"
  remote "cd '$app_dir' && timeout 300 python3 scripts/smoke_render.py http://127.0.0.1:8790 $code_arg" | grep -E "batch|finished|done|failed" || { echo "!!  smoke failed"; exit 1; }
fi

echo "==> done: $rev deployed"
