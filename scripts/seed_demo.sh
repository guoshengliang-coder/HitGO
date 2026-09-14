#!/usr/bin/env bash
# Seed a running HitGO instance with a demo batch: uploads every *.mp4/*.mov in
# <media_dir> as one batch and every *.png/*.webp as sticker assets.
#
# Usage: seed_demo.sh <base_url> <access_code> <media_dir> [batch_name]
#   e.g. seed_demo.sh http://127.0.0.1:8790 <access_code> /srv/hitgo/demo "演示批次"
set -euo pipefail

base="${1:?base_url}"
code="${2:?access_code}"
dir="${3:?media_dir}"
name="${4:-演示批次 $(date +%m-%d\ %H:%M)}"

jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT

curl -fsS -c "$jar" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$code\"}" "$base/api/auth" >/dev/null
echo "auth ok"

# stickers
args=()
for f in "$dir"/*.png "$dir"/*.webp; do
  [ -f "$f" ] && args+=(-F "files=@$f")
done
if [ ${#args[@]} -gt 0 ]; then
  curl -fsS -b "$jar" -F type=sticker "${args[@]}" "$base/api/assets" \
    | python3 -c 'import json,sys; a=json.load(sys.stdin); print(f"stickers: {len(a)} uploaded")'
fi

# batch + videos
batch_id=$(curl -fsS -b "$jar" -H 'Content-Type: application/json' \
  -d "{\"name\":\"$name\"}" "$base/api/batches" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "batch: $batch_id"

args=()
for f in "$dir"/*.mp4 "$dir"/*.mov; do
  [ -f "$f" ] && args+=(-F "files=@$f")
done
curl -fsS -b "$jar" "${args[@]}" "$base/api/batches/$batch_id/videos" \
  | python3 -c 'import json,sys; v=json.load(sys.stdin); print(f"videos: {len(v)} uploaded, preprocessing queued")'

echo "open: $base/batches/$batch_id"
