"""HIG-39 multi-source edit validation and real FFmpeg composition."""

from __future__ import annotations

import shutil
import subprocess
import array
import math

import pytest

from app.db import utcnow
from app.models import Video
from app.schemas import EditSpec
from app.services import ffprobe, storage
from app.services.filtergraph import AudioSource, build_render_command
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
    for gain in (-0.1, 1.1):
        with pytest.raises(ValueError):
            EditSpec.model_validate(sequence_spec({**clip('c1', 'v1'), 'source_volume': gain}))
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


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="requires ffmpeg")
@pytest.mark.parametrize("legacy", [True, False])
def test_inserted_audio_and_owner_dubbing_have_distinct_correct_signals(tmp_path, legacy):
    """880 Hz insertion, then 660/990 Hz owner dub after a source cut; never 440 Hz owner raw."""
    owner, inserted, dubbed, output = (tmp_path / name for name in ('owner.mp4', 'inserted.mp4', 'dub.wav', 'result.mp4'))
    for path, frequency in ((owner, 440), (inserted, 880)):
        subprocess.run([
            'ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=128x128:r=25:d=4',
            '-f', 'lavfi', '-i', f'sine=frequency={frequency}:duration=4',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', str(path),
        ], check=True, capture_output=True)
    subprocess.run([
        'ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=990:duration=2',
        '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', str(dubbed),
    ], check=True, capture_output=True)
    data = sequence_spec(clip('new', 'inserted'), clip('a', 'owner'), clip('b', 'owner', 2, 3))
    data['audio'] = {'source_volume': 0 if legacy else 1, 'tracks': [{'id': 'dub', 'asset_id': 'dub', 'align': 'source', 't': 'all'}]}
    if not legacy:
        for c in data['sequence']['clips']:
            c['source_volume'] = 1 if c['video_id'] == 'inserted' else 0
    spec = EditSpec.model_validate(data)
    sources = [ClipSource(c, str(inserted if c.video_id == 'inserted' else owner), 128, 128, 25, True) for c in spec.sequence.clips]
    plan = build_render_command(spec, {'video_id': 'owner', 'duration': 4, 'width': 128, 'height': 128, 'fps': 25, 'has_audio': True}, {}, spec.outputs[0], source_path=str(owner), output_path=str(output), sequence_sources=sources, audio_assets={'dub': AudioSource(str(dubbed), 4)})
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=60)
    assert ffprobe.probe(output)['duration'] == pytest.approx(3, abs=0.12)
    for start, expected in ((0.3, 880), (1.3, 660), (2.3, 990)):
        decoded = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(start), '-i', str(output), '-t', '0.2', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'], check=True, capture_output=True).stdout
        samples = array.array('f')
        samples.frombytes(decoded)
        def amplitude(frequency):
            sine = sum(value * math.sin(2 * math.pi * frequency * i / 8000) for i, value in enumerate(samples))
            cosine = sum(value * math.cos(2 * math.pi * frequency * i / 8000) for i, value in enumerate(samples))
            return 2 * math.hypot(sine, cosine) / len(samples)
        energies = {frequency: amplitude(frequency) for frequency in (440, 660, 880, 990)}
        assert energies[expected] > 0.02, energies
        assert energies[expected] > 10 * max(value for frequency, value in energies.items() if frequency != expected), energies


def test_explicit_all_clip_mute_does_not_fall_back_to_first_input_audio():
    data = sequence_spec({**clip('a', 'owner'), 'source_volume': 0}, {**clip('b', 'new'), 'source_volume': 0})
    spec = EditSpec.model_validate(data)
    sources = [ClipSource(c, f'/{c.video_id}.mp4', 128, 128, 25, True) for c in spec.sequence.clips]
    plan = build_render_command(spec, {'video_id': 'owner', 'duration': 1, 'has_audio': True}, {}, spec.outputs[0], source_path='/owner.mp4', output_path='/out.mp4', sequence_sources=sources)
    assert '-an' in plan.argv
    assert '0:a:0' not in plan.argv
