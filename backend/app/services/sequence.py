"""Resolve and validate a multi-clip sequence against source videos (HIG-39)."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import JOB_ACTIVE, VIDEO_READY, Job, Video
from app.schemas import EditSpec, SequenceClip, VideoTrackClip
from app.services import storage


@dataclass(frozen=True)
class ClipSource:
    clip: SequenceClip
    path: str
    width: int
    height: int
    fps: float
    has_audio: bool


@dataclass(frozen=True)
class VideoTrackSource:
    track_id: str
    clip: VideoTrackClip
    path: str
    width: int
    height: int
    fps: float


def _source_video(db: Session, owner: Video, clip_id: str, video_id: str, cache: dict[str, Video | None]) -> Video:
    if video_id not in cache:
        cache[video_id] = db.get(Video, video_id)
    source = cache[video_id]
    if source is None or source.batch_id != owner.batch_id:
        raise ValueError(f"片段 {clip_id} 的源视频不存在或不属于当前批次")
    if source.kind not in ("video", "image") or source.status != VIDEO_READY or not source.duration or not source.width or not source.height:
        raise ValueError(f"片段 {clip_id} 的源视频尚未就绪")
    return source


def resolve_sequence(db: Session, owner: Video, spec: EditSpec) -> list[ClipSource]:
    """Only same-batch, ready raw sources may appear in a saved or rendered sequence."""
    if spec.sequence is None:
        return []
    if owner.kind != "video":
        raise ValueError("只有视频素材可以创建多片段序列")
    result: list[ClipSource] = []
    cache: dict[str, Video | None] = {}
    for clip in spec.sequence.clips:
        source = _source_video(db, owner, clip.id, clip.video_id, cache)
        # Uploaded images are preprocessed into five-second source.mp4 files and can
        # therefore use the same trim, preview and render path as a video clip.
        if clip.source_out > source.duration + 1e-3:
            raise ValueError(f"片段 {clip.id} 的结束时间超出源视频时长")
        path = storage.source_path(source.batch_id, source.id, source.source_ext)
        if not path.is_file():
            raise ValueError(f"片段 {clip.id} 的源文件不存在")
        result.append(ClipSource(clip, str(path), source.width, source.height, source.fps or 30, source.has_audio))
    return result


def resolve_video_tracks(db: Session, owner: Video, spec: EditSpec) -> list[VideoTrackSource]:
    """Resolve visible HIG-81 upper-track clips in paint order."""
    result: list[VideoTrackSource] = []
    cache: dict[str, Video | None] = {}
    for track in spec.video_tracks:
        for clip in sorted(track.clips, key=lambda item: item.start):
            source = _source_video(db, owner, clip.id, clip.video_id, cache)
            if clip.source_out > source.duration + 1e-3:
                raise ValueError(f"片段 {clip.id} 的结束时间超出源视频时长")
            path = storage.source_path(source.batch_id, source.id, source.source_ext)
            if not path.is_file():
                raise ValueError(f"片段 {clip.id} 的源文件不存在")
            if not track.hidden:
                result.append(VideoTrackSource(track.id, clip, str(path), source.width, source.height, source.fps or 30))
    return result


def _referenced_video_ids(raw: dict) -> set[str]:
    sequence = ((raw or {}).get("sequence") or {}).get("clips", [])
    upper = [clip for track in (raw or {}).get("video_tracks", []) for clip in track.get("clips", [])]
    return {clip.get("video_id") for clip in [*sequence, *upper] if clip.get("video_id")}


def referencing_videos(db: Session, source: Video) -> list[Video]:
    """Other saved edits that would break if this raw source were removed."""
    videos = db.scalars(select(Video).where(Video.batch_id == source.batch_id, Video.id != source.id)).all()
    return [
        video for video in videos
        if source.id in _referenced_video_ids(video.edit_spec or {})
    ]


def active_jobs_referencing(db: Session, source: Video) -> list[Job]:
    """Queued/running job snapshots must keep their source files even if an edit changed."""
    jobs = db.scalars(select(Job).where(Job.batch_id == source.batch_id, Job.status.in_(JOB_ACTIVE))).all()
    return [
        job for job in jobs
        if source.id in _referenced_video_ids(job.edit_spec or {})
    ]
