"""ORM tables: Batch, Video, Asset, Job, Upload, Preset (contract §1 / §5)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base, utcnow

# Statuses (kept as plain strings so they stay portable across SQLite / PostgreSQL)
VIDEO_PREPARING = "preparing"
VIDEO_READY = "ready"
VIDEO_FAILED = "failed"

JOB_QUEUED = "queued"
JOB_RUNNING = "running"
JOB_DONE = "done"
JOB_FAILED = "failed"
JOB_ACTIVE = (JOB_QUEUED, JOB_RUNNING)

ASSET_STICKER = "sticker"
ASSET_FONT = "font"

# Asset.source (contract §1). "library" is reserved for the real material library we will
# eventually point at; nothing in the prototype creates it. See docs/ASSETS.md.
ASSET_SOURCE_UPLOAD = "upload"
ASSET_SOURCE_BUILTIN = "builtin"
ASSET_SOURCE_LIBRARY = "library"
ASSET_SOURCES = (ASSET_SOURCE_UPLOAD, ASSET_SOURCE_BUILTIN, ASSET_SOURCE_LIBRARY)


class Batch(Base):
    __tablename__ = "batches"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    videos: Mapped[list[Video]] = relationship(
        back_populates="batch", cascade="all, delete-orphan", order_by="Video.order_index"
    )
    jobs: Mapped[list[Job]] = relationship(back_populates="batch", cascade="all, delete-orphan")


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    batch_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("batches.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default=VIDEO_PREPARING, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    fps: Mapped[float | None] = mapped_column(Float, nullable=True)
    has_audio: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    codec: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source_ext: Mapped[str] = mapped_column(String(8), default="mp4", nullable=False)

    sprite: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    edit_spec: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )

    batch: Mapped[Batch] = relationship(back_populates="videos")
    jobs: Mapped[list[Job]] = relationship(back_populates="video", cascade="all, delete-orphan")


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    type: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    ext: Mapped[str] = mapped_column(String(8), nullable=False)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    family: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source: Mapped[str] = mapped_column(String(16), default=ASSET_SOURCE_UPLOAD, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    batch_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("batches.id", ondelete="CASCADE"), index=True, nullable=False
    )
    video_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("videos.id", ondelete="CASCADE"), index=True, nullable=False
    )
    variant_key: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default=JOB_QUEUED, nullable=False, index=True)
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    output: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    callback: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Incremented on retry; part of the callback idempotency key.
    attempt: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    batch: Mapped[Batch] = relationship(back_populates="jobs")
    video: Mapped[Video] = relationship(back_populates="jobs")


class Upload(Base):
    """Text-layer PNGs rendered by the frontend (contract: POST /api/uploads/layer-image)."""

    __tablename__ = "uploads"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class Preset(Base):
    """User-saved presets, e.g. text styles (contract §1 Preset, §3 /api/presets)."""

    __tablename__ = "presets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(40), nullable=False)
    data: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
