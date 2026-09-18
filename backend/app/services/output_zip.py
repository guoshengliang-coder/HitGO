"""Batch download of finished outputs as one zip (contract §3 ``POST /api/outputs/zip``, HIG-47).

Outputs are already-compressed mp4, so entries are STORED (no deflate) and the archive is
written straight into the response as it goes: the first bytes leave within milliseconds and
bytes keep flowing, so a proxy in front (Cloudflare gives up on an origin that is silent for
~100 s) never sees an idle connection, and a multi-GB zip never sits on disk or in memory.
"""

from __future__ import annotations

import re
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

CHUNK = 1 << 20
# Same rule as frontend lib/outputs.ts outputFileName: Windows / macOS-unsafe characters -> "_".
_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')
_PART_MAX = 80
_VIDEO_EXT = re.compile(r"\.(mp4|mov|png|jpg|jpeg)$", re.IGNORECASE)


def _safe_part(value: str | None) -> str:
    s = _UNSAFE.sub("_", value or "")
    s = re.sub(r"\s+", " ", s).strip()
    return s[:_PART_MAX].strip()


def output_file_name(
    job_id: str,
    variant_key: str,
    export_name: str | None,
    batch_name: str | None,
    video_name: str | None,
    lang_label: str | None = None,
    output_format: str = "mp4",
) -> str:
    """A safe download name with the actual job extension."""
    video = _VIDEO_EXT.sub("", video_name or "")
    parts = [
        p
        for p in (_safe_part(export_name or batch_name), _safe_part(video), _safe_part(lang_label), _safe_part(variant_key))
        if p
    ]
    return f"{'_'.join(parts) if parts else job_id}.{output_format}"


def dedupe_names(names: list[str]) -> list[str]:
    """Second and later copies of a name get `` (2)``, `` (3)`` before the extension."""
    seen: set[str] = set()
    out: list[str] = []
    for name in names:
        stem, dot, ext = name.rpartition(".")
        if not dot:
            stem, ext = name, ""
        candidate, n = name, 1
        while candidate.lower() in seen:
            n += 1
            candidate = f"{stem} ({n}).{ext}" if ext else f"{stem} ({n})"
        seen.add(candidate.lower())
        out.append(candidate)
    return out


@dataclass(frozen=True)
class ZipEntry:
    name: str
    path: Path
    modified: datetime | None = None


class _Sink:
    """Write-only buffer ZipFile writes into; the generator drains it after every chunk.

    No ``seek`` / ``tell``: zipfile then wraps it and writes data descriptors after each entry,
    which is what lets the archive be produced front to back without knowing CRCs up front.
    """

    def __init__(self) -> None:
        self._buf = bytearray()

    def write(self, data: bytes) -> int:
        self._buf += data
        return len(data)

    def flush(self) -> None:
        pass

    def drain(self) -> bytes:
        data = bytes(self._buf)
        self._buf.clear()
        return data


def stream_zip(entries: list[ZipEntry]) -> Iterator[bytes]:
    sink = _Sink()
    with zipfile.ZipFile(sink, mode="w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:  # type: ignore[arg-type]
        for entry in entries:
            stamp = entry.modified or datetime.now()
            info = zipfile.ZipInfo(entry.name, date_time=stamp.timetuple()[:6])
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o644 << 16
            with entry.path.open("rb") as src, zf.open(info, mode="w", force_zip64=True) as dst:
                while chunk := src.read(CHUNK):
                    dst.write(chunk)
                    yield sink.drain()
            yield sink.drain()
    yield sink.drain()
