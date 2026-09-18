"""Resolve and validate a multi-clip sequence against source videos (HIG-39)."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import JOB_ACTIVE, VIDEO_READY, Job, Video
from app.schemas import EditSpec, SequenceClip
from app.services import storage


@dataclass(frozen=True)
class ClipSource:
    clip: SequenceClip
    path: str
    width: int
    height: int
    fps: float
    has_audio: bool


def resolve_sequence(db: Session, owner: Video, spec: EditSpec) -> list[ClipSource]:
    """Only same-batch, ready raw sources may appear in a saved or rendered sequence."""
    if spec.sequence is None:
        return []
    if owner.kind != "video":
        raise ValueError("只有视频素材可以创建多片段序列")
    result: list[ClipSource] = []
    cache: dict[str, Video | None] = {}
    for clip in spec.sequence.clips:
        if clip.video_id not in cache:
            cache[clip.video_id] = db.get(Video, clip.video_id)
        source = cache[clip.video_id]
        if source is None or source.batch_id != owner.batch_id:
            raise ValueError(f"片段 {clip.id} 的源视频不存在或不属于当前批次")
        # Uploaded images are preprocessed into five-second source.mp4 files and can
        # therefore use the same trim, preview and render path as a video clip.
        if source.kind not in ("video", "image") or source.status != VIDEO_READY or not source.duration or not source.width or not source.height:
            raise ValueError(f"片段 {clip.id} 的源视频尚未就绪")
        if clip.source_out > source.duration + 1e-3:
            raise ValueError(f"片段 {clip.id} 的结束时间超出源视频时长")
        path = storage.source_path(source.batch_id, source.id, source.source_ext)
        if not path.is_file():
            raise ValueError(f"片段 {clip.id} 的源文件不存在")
        result.append(ClipSource(clip, str(path), source.width, source.height, source.fps or 30, source.has_audio))
    return result


def referencing_videos(db: Session, source: Video) -> list[Video]:
    """Other saved edits that would break if this raw source were removed."""
    videos = db.scalars(select(Video).where(Video.batch_id == source.batch_id, Video.id != source.id)).all()
    return [
        video for video in videos
        if any(clip.get("video_id") == source.id for clip in ((video.edit_spec or {}).get("sequence") or {}).get("clips", []))
    ]


def active_jobs_referencing(db: Session, source: Video) -> list[Job]:
    """Queued/running job snapshots must keep their source files even if an edit changed."""
    jobs = db.scalars(select(Job).where(Job.batch_id == source.batch_id, Job.status.in_(JOB_ACTIVE))).all()
    return [
        job for job in jobs
        if any(clip.get("video_id") == source.id for clip in ((job.edit_spec or {}).get("sequence") or {}).get("clips", []))
    ]
