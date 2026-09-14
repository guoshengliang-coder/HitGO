# HitGO backend

FastAPI API + Celery render worker. Single source of truth for behaviour: `../docs/CONTRACT.md`.
Deviations and judgement calls: `NOTES.md`.

## Run

```bash
uv sync
export DATA_DIR=$PWD/../data ENV=dev          # REDIS_URL defaults to redis://localhost:6379/0
uv run uvicorn app.main:app --reload --port 8000
uv run celery -A app.worker worker --loglevel=info --concurrency=1   # needs Redis + ffmpeg
```

The API starts without Redis; enqueue attempts then return HTTP 503 with a clear `detail`.
`ffmpeg` / `ffprobe` are only needed by the worker (`FFMPEG_BIN` / `FFPROBE_BIN` override the path).

Useful URLs: `GET /api/health`, `GET /api/docs` (OpenAPI UI), `GET /api/safe-zones`.

## Test

```bash
uv run pytest            # no ffmpeg required; integration cases skip when it is absent
```

## Layout

```
app/main.py         app factory, /media static, SPA fallback, access-code gate
app/config.py       env → settings
app/db.py models.py schemas.py serializers.py ids.py
app/routers/        auth batches videos assets uploads render jobs config
app/services/       storage ffprobe preprocess layout filtergraph render apply
app/worker.py       Celery app + tasks preprocess_video / render_job
app/data/safe_zones.json
tests/
```
