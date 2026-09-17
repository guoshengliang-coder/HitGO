"""HIG-39 multi-source edit validation and real FFmpeg composition."""

from __future__ import annotations

import shutil
import subprocess

import pytest

from app.db import utcnow
from app.models import Video
from app.schemas import EditSpec
from app.services import ffprobe, storage
from app.services.filtergraph import build_render_command
from app.services.sequence import ClipSource


def sequence_spec(*clips):
    return {
        "spec_version": 1,
        "trim": {"remove": []},
        "layers": [],
        "outputs": [{"variant_key": "custom", "aspect": "custom", "width": 128, "height": 128, "fill": "color"}],
        "sequence": {"clips": list(clips)},
    }


def clip(id, video_id, start=0, end=1, transition=None):
    value = {"id": id, "video_id": video_id, "in": start, "out": end}
    if transition is not None:
        value["transition"] = transition
    return value


def test_sequence_schema_rejects_invalid_clips():
    with pytest.raises(ValueError, match="第一段"):
        EditSpec.model_validate(sequence_spec(clip("c1", "v1", transition={"type": "fade", "duration": 0.2})))
    with pytest.raises(ValueError, match="片段 id"):
        EditSpec.model_validate(sequence_spec(clip("c1", "v1"), clip("c1", "v2")))
    with pytest.raises(ValueError, match="转场时长"):
        EditSpec.model_validate(sequence_spec(clip("c1", "v1", end=0.2), clip("c2", "v2", transition={"type": "fade", "duration": 0.2})))
    with pytest.raises(ValueError, match="旧的 trim"):
        EditSpec.model_validate({**sequence_spec(clip("c1", "v1")), "trim": {"remove": [[0, 0.2]]}})


def test_sequence_sources_must_be_ready_and_same_batch(client, ready_video, db):
    second = Video(
        id="v_sequence_2", batch_id=ready_video.batch_id, name="第二段.mp4", order_index=1,
        status="ready", width=128, height=128, duration=2, fps=25, has_audio=False,
        created_at=utcnow(), updated_at=utcnow(),
    )
    db.add(second)
    db.commit()
    path = storage.source_path(second.batch_id, second.id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"source")
    spec = sequence_spec(clip("c1", ready_video.id), clip("c2", second.id))
    assert client.put(f"/api/videos/{ready_video.id}/spec", json={"edit_spec": spec}).status_code == 200
    assert client.delete(f"/api/videos/{second.id}").status_code == 409
    spec["sequence"]["clips"][1]["out"] = 9
    assert client.put(f"/api/videos/{ready_video.id}/spec", json={"edit_spec": spec}).status_code == 400
    spec["sequence"]["clips"][1]["video_id"] = "v_missing"
    assert client.put(f"/api/videos/{ready_video.id}/spec", json={"edit_spec": spec}).status_code == 400
    spec["sequence"]["clips"][1]["video_id"] = second.id
    spec["sequence"]["clips"][1]["out"] = 1
    second.kind = "image"
    db.commit()
    assert client.put(f"/api/videos/{ready_video.id}/spec", json={"edit_spec": spec}).status_code == 400


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="requires ffmpeg")
def test_real_multiclip_render_with_fade_and_wipe(tmp_path):
    first = tmp_path / "first.mp4"
    second = tmp_path / "second.mp4"
    third = tmp_path / "third.mp4"
    output = tmp_path / "joined.mp4"
    for path, color, audio in ((first, "red", True), (second, "blue", False), (third, "green", True)):
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"color=c={color}:s=128x128:r=25:d=1.2"]
        if audio:
            cmd += ["-f", "lavfi", "-i", "sine=frequency=440:duration=1.2", "-shortest", "-c:a", "aac"]
        subprocess.run([*cmd, "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)], check=True)
    spec = EditSpec.model_validate(sequence_spec(
        clip("c1", "v1"),
        clip("c2", "v2", transition={"type": "fade", "duration": 0.3}),
        clip("c3", "v3", transition={"type": "wipe_right", "duration": 0.2}),
    ))
    sources = [
        ClipSource(spec.sequence.clips[0], str(first), 128, 128, 25, True),
        ClipSource(spec.sequence.clips[1], str(second), 128, 128, 25, False),
        ClipSource(spec.sequence.clips[2], str(third), 128, 128, 25, True),
    ]
    plan = build_render_command(
        spec, {"video_id": "v1", "duration": 1.2, "width": 128, "height": 128, "fps": 25, "has_audio": True},
        {}, spec.outputs[0], source_path=str(first), output_path=str(output), sequence_sources=sources,
    )
    assert plan.expected_duration == pytest.approx(2.5)
    assert "xfade=transition=fade" in plan.filter_complex
    assert "xfade=transition=wiperight" in plan.filter_complex
    subprocess.run(plan.argv, check=True, capture_output=True)
    info = ffprobe.probe(output)
    assert info["duration"] == pytest.approx(2.5, abs=0.12)
    assert info["has_audio"]
