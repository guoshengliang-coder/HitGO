# syntax=docker/dockerfile:1.7
# HitGO single image: Vite frontend build → python:3.12-slim + ffmpeg + uv.
# Used by both the `api` and `worker` services in docker-compose.yml.

# ---------- stage 1: frontend ----------
FROM node:22-alpine AS frontend
WORKDIR /src
# Copy the whole frontend dir (may be absent/empty before the frontend lands).
COPY frontend/ ./frontend/
RUN set -eu; \
    if [ -f frontend/package.json ]; then \
        cd frontend && npm ci && npm run build; \
    else \
        mkdir -p frontend/dist && \
        printf '<!doctype html><title>HitGO</title><p>frontend not built</p>' > frontend/dist/index.html; \
    fi

# ---------- stage 2: backend ----------
FROM python:3.12-slim AS runtime

ARG HITGO_BUILD_SHA=unknown
ARG HITGO_BUILD_VERSION=dev

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/app/backend/.venv \
    DATA_DIR=/data \
    FRONTEND_DIST=/app/frontend/dist \
    SAMPLES_DIR=/app/samples \
    HITGO_BUILD_SHA=${HITGO_BUILD_SHA} \
    HITGO_BUILD_VERSION=${HITGO_BUILD_VERSION}

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

RUN groupadd --system hitgo && useradd --system --gid hitgo --create-home hitgo \
    && mkdir -p /app /data && chown -R hitgo:hitgo /app /data

WORKDIR /app/backend

# Dependencies first (cached unless pyproject/uv.lock change).
COPY --chown=hitgo:hitgo backend/pyproject.toml backend/uv.lock backend/.python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY --chown=hitgo:hitgo backend/app ./app
COPY --chown=hitgo:hitgo samples/ /app/samples/
COPY --chown=hitgo:hitgo --from=frontend /src/frontend/dist /app/frontend/dist
RUN chown -R hitgo:hitgo /app

USER hitgo
VOLUME ["/data"]
EXPOSE 8000

CMD ["uv", "run", "--no-sync", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
