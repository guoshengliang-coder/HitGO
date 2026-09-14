"""Mark render jobs that have sat in `queued` for too long as failed so they can be retried.

Run inside the api container:
    docker compose exec -T api uv run --no-sync python - < scripts/fail_stale_queued.py
"""
from datetime import timedelta

from sqlalchemy import select

from app.db import SessionLocal, utcnow
from app.models import JOB_FAILED, JOB_QUEUED, Job

STALE_AFTER = timedelta(minutes=2)

db = SessionLocal()
cutoff = utcnow() - STALE_AFTER
stale = [j for j in db.scalars(select(Job).where(Job.status == JOB_QUEUED)) if j.created_at < cutoff]
for job in stale:
    job.status = JOB_FAILED
    job.error = "任务长时间未被执行，已标记失败，可重试"
    job.finished_at = utcnow()
db.commit()
print(f"marked {len(stale)} stale queued job(s) as failed")
