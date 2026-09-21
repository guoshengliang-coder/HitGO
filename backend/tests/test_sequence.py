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
from app.services.render import collect_audio
from app.services.filtergraph import AudioSource, build_render_command
from app.services.sequence import ClipSource, VideoTrackSource


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
    assert EditSpec.model_validate({**sequence_spec(clip("c1", "v1")), "trim": {"remove": [[0, 0.2]]}}).trim.remove == [(0, 0.2)]
    with pytest.raises(ValueError, match="整条视频"):
        EditSpec.model_validate({**sequence_spec(clip("c1", "v1")), "trim": {"remove": [[0, 1]]}})
    with pytest.raises(ValueError, match="超出视频时长"):
        EditSpec.model_validate({**sequence_spec(clip("c1", "v1")), "trim": {"remove": [[0, 2]]}})
    for speed in (0.49, 2.01):
        with pytest.raises(ValueError):
            EditSpec.model_validate(sequence_spec({**clip("c1", "v1"), "speed": speed}))
    timed = EditSpec.model_validate(sequence_spec(
        {**clip("slow", "v1", end=1), "speed": 0.8},
        {**clip("fast", "v1", end=1), "speed": 1.25, "localize_cue": 0},
    ))
    assert timed.sequence.duration == pytest.approx(2.05)


def test_upper_video_track_schema_and_filtergraph():
    data = sequence_spec(clip("main", "owner", end=4))
    data["video_tracks"] = [{
        "id": "vt2", "clips": [
            {"id": "upper", "video_id": "other", "start": 1, "in": 0.5, "out": 2.5, "speed": 2},
        ],
    }]
    spec = EditSpec.model_validate(data)
    source = VideoTrackSource("vt2", spec.video_tracks[0].clips[0], "/other.mp4", 1920, 1080, 25)
    main = ClipSource(spec.sequence.clips[0], "/owner.mp4", 128, 128, 25, False)
    plan = build_render_command(
        spec, {"video_id": "owner", "duration": 4, "width": 128, "height": 128, "fps": 25, "has_audio": False},
        {}, spec.outputs[0], source_path="/owner.mp4", output_path="/out.mp4",
        sequence_sources=[main], video_track_sources=[source],
    )
    assert plan.argv.count("/other.mp4") == 1
    assert "trim=start=0.5:end=2.5,setpts=(PTS-STARTPTS)/2+1/TB" in plan.filter_complex
    assert "overlay=0:0:eof_action=pass:enable='between(t,1,2)'" in plan.filter_complex

    data["video_tracks"][0]["clips"][0]["transform"] = {"fit": "contain", "scale": 0.5, "x": 0.25, "y": 0.75}
    transformed = EditSpec.model_validate(data)
    plan = build_render_command(
        transformed, {"video_id": "owner", "duration": 4, "width": 128, "height": 128, "fps": 25, "has_audio": False},
        {}, transformed.outputs[0], source_path="/owner.mp4", output_path="/out.mp4",
        sequence_sources=[ClipSource(transformed.sequence.clips[0], "/owner.mp4", 128, 128, 25, False)],
        video_track_sources=[VideoTrackSource("vt2", transformed.video_tracks[0].clips[0], "/other.mp4", 1920, 1080, 25)],
    )
    assert "scale=64:36,format=rgba[vtfront_upper0]" in plan.filter_complex
    assert "colorchannelmixer=aa=0[vtbase_upper0]" in plan.filter_complex
    assert "overlay=0:78:eof_action=pass:format=auto[upperfill0]" in plan.filter_complex

    data["video_tracks"][0]["clips"].append({"id": "overlap", "video_id": "other", "start": 1.5, "in": 0, "out": 1})
    with pytest.raises(ValueError, match="不能重叠"):
        EditSpec.model_validate(data)


def test_video_transform_and_linked_video_audio_schema():
    data = sequence_spec({**clip("main", "owner", end=4), "transform": {"fit": "cover", "scale": 1.2, "x": 0.4, "y": 0.6, "crop": {"x": 0.1, "y": 0.1, "w": 0.8, "h": 0.8}}})
    data["video_tracks"] = [{"id": "vt", "clips": [{"id": "upper", "video_id": "other", "start": 1, "in": 0, "out": 2}]}]
    data["audio"] = {"source_volume": 1, "tracks": [{"id": "va1", "source_kind": "video", "asset_id": "other", "linked_clip_id": "upper", "role": "voice", "t": [1, 3], "offset": 0.5}]}
    spec = EditSpec.model_validate(data)
    assert spec.sequence.clips[0].transform.fit == "cover"
    assert spec.audio.tracks[0].source_kind == "video"
    assert spec.audio.tracks[0].linked_clip_id == "upper"
    broken_link = {**data, "audio": {"source_volume": 1, "tracks": [{"id": "va1", "source_kind": "video", "asset_id": "wrong", "linked_clip_id": "upper", "t": [1, 3]}]}}
    with pytest.raises(ValueError, match="linked_clip_id"):
        EditSpec.model_validate(broken_link)
    for patch in ({"scale": 0.01}, {"x": 4}, {"crop": {"x": 0.8, "y": 0, "w": 0.3, "h": 1}}):
        bad = sequence_spec({**clip("main", "owner", end=4), "transform": patch})
        with pytest.raises(ValueError):
            EditSpec.model_validate(bad)


def test_collect_audio_resolves_video_source(db, ready_video):
    data = sequence_spec(clip("main", ready_video.id, end=4))
    data["audio"] = {"source_volume": 1, "tracks": [{"id": "va1", "source_kind": "video", "asset_id": ready_video.id, "role": "voice", "t": [1, 3]}]}
    sources = collect_audio(db, EditSpec.model_validate(data), ready_video)
    assert sources[ready_video.id].path == str(storage.source_path(ready_video.batch_id, ready_video.id, ready_video.source_ext))
    assert sources[ready_video.id].duration == ready_video.duration


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="requires ffmpeg")
def test_real_upper_video_track_render(tmp_path):
    owner, upper, output = (tmp_path / name for name in ("owner.mp4", "upper.mp4", "upper-result.mp4"))
    for path, color, seconds in ((owner, "red", 3), (upper, "blue", 1)):
        subprocess.run([
            "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={color}:s=128x96:r=25:d={seconds}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path),
        ], check=True, capture_output=True)
    data = sequence_spec(clip("main", "owner", end=3))
    data["video_tracks"] = [{"id": "vt2", "clips": [{"id": "upper", "video_id": "other", "start": 1, "in": 0, "out": 1, "transform": {"fit": "contain", "scale": 0.5, "x": 0.25, "y": 0.5}}]}]
    spec = EditSpec.model_validate(data)
    plan = build_render_command(
        spec, {"video_id": "owner", "duration": 3, "width": 128, "height": 96, "fps": 25, "has_audio": False},
        {}, spec.outputs[0], source_path=str(owner), output_path=str(output),
        sequence_sources=[ClipSource(spec.sequence.clips[0], str(owner), 128, 96, 25, False)],
        video_track_sources=[VideoTrackSource("vt2", spec.video_tracks[0].clips[0], str(upper), 128, 96, 25)],
    )
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=30)
    assert ffprobe.probe(output)["duration"] == pytest.approx(3, abs=0.12)


def test_composed_trim_persists_and_renders_beyond_owner_duration(client, ready_video):
    spec = sequence_spec(clip('a', ready_video.id, end=24), clip('b', ready_video.id, end=24))
    spec['trim']['remove'] = [[30, 35]]
    saved = client.put(f'/api/videos/{ready_video.id}/spec', json={'edit_spec': spec})
    assert saved.status_code == 200, saved.text
    reopened = client.get(f'/api/videos/{ready_video.id}').json()['edit_spec']
    assert reopened['trim']['remove'] == [[30, 35]]
    rendered = client.post('/api/render', json={'video_ids': [ready_video.id]})
    assert rendered.status_code == 201, rendered.text
    spec['trim']['remove'] = [[47, 49]]
    assert client.put(f'/api/videos/{ready_video.id}/spec', json={'edit_spec': spec}).status_code == 400


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
    assert client.put(f"/api/videos/{ready_video.id}/spec", json={"edit_spec": spec}).status_code == 200
    second.kind = "blank"
    db.commit()
    assert client.put(f"/api/videos/{ready_video.id}/spec", json={"edit_spec": spec}).status_code == 400


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="requires ffmpeg")
@pytest.mark.parametrize("cut", [False, True])
def test_real_multiclip_render_with_fade_and_wipe(tmp_path, cut):
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
    if cut:
        spec.trim.remove = [(0.8, 1.4)]
    plan = build_render_command(
        spec, {"video_id": "v1", "duration": 1.2, "width": 128, "height": 128, "fps": 25, "has_audio": True},
        {}, spec.outputs[0], source_path=str(first), output_path=str(output), sequence_sources=sources,
    )
    assert plan.expected_duration == pytest.approx(1.9 if cut else 2.5)
    assert "xfade=transition=fade" in plan.filter_complex
    assert "xfade=transition=wiperight" in plan.filter_complex
    subprocess.run(plan.argv, check=True, capture_output=True)
    info = ffprobe.probe(output)
    assert info["duration"] == pytest.approx(1.9 if cut else 2.5, abs=0.12)
    assert info["has_audio"]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="requires ffmpeg")
@pytest.mark.parametrize("legacy", [True, False])
@pytest.mark.parametrize("cut", [False, True])
def test_inserted_audio_and_owner_dubbing_have_distinct_correct_signals(tmp_path, legacy, cut):
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
    if cut:
        data['trim']['remove'] = [[0.5, 1.5]]
    if not legacy:
        for c in data['sequence']['clips']:
            c['source_volume'] = 1 if c['video_id'] == 'inserted' else 0
    spec = EditSpec.model_validate(data)
    sources = [ClipSource(c, str(inserted if c.video_id == 'inserted' else owner), 128, 128, 25, True) for c in spec.sequence.clips]
    plan = build_render_command(spec, {'video_id': 'owner', 'duration': 4, 'width': 128, 'height': 128, 'fps': 25, 'has_audio': True}, {}, spec.outputs[0], source_path=str(owner), output_path=str(output), sequence_sources=sources, audio_assets={'dub': AudioSource(str(dubbed), 4)})
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=60)
    assert ffprobe.probe(output)['duration'] == pytest.approx(2 if cut else 3, abs=0.12)
    for start, expected in (((0.2, 880), (0.7, 660), (1.3, 990)) if cut else ((0.3, 880), (1.3, 660), (2.3, 990))):
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


def test_sequence_speed_retimes_picture_source_audio_and_source_aligned_stems():
    data = sequence_spec({**clip('a', 'owner', end=2), 'speed': 0.8, 'source_volume': 1})
    data['audio'] = {'source_volume': 1, 'tracks': [{'id': 'stem', 'asset_id': 'stem', 'align': 'source', 't': 'all'}]}
    spec = EditSpec.model_validate(data)
    source = ClipSource(spec.sequence.clips[0], '/owner.mp4', 128, 128, 25, True)
    plan = build_render_command(
        spec,
        {'video_id': 'owner', 'duration': 2, 'width': 128, 'height': 128, 'fps': 25, 'has_audio': True},
        {}, spec.outputs[0], source_path='/owner.mp4', output_path='/out.mp4', sequence_sources=[source],
        audio_assets={'stem': AudioSource('/stem.m4a', 2)},
    )
    assert plan.expected_duration == pytest.approx(2.5)
    assert 'setpts=(PTS-STARTPTS)/0.8' in plan.filter_complex
    assert plan.filter_complex.count('atempo=0.8') == 2  # raw source audio + source-aligned stem


def test_compound_groups_and_splits_validate_and_round_trip(client, ready_video):
    """HIG-85: group ids on layers / tracks / clips and trim.splits are editor-only and survive a save."""
    spec = sequence_spec({**clip("main", ready_video.id, end=4), "group": "cg_main"})
    spec["video_tracks"] = [{"id": "vt", "clips": [{"id": "upper", "video_id": ready_video.id, "start": 1, "in": 0, "out": 2, "group": "cg_upper"}]}]
    spec["layers"] = [{"id": "l1", "type": "shape", "shape": "rect", "t": [0, 2], "group": "cg_main"}]
    spec["audio"] = {"source_volume": 1, "tracks": [{"id": "a1", "asset_id": "a_x", "t": [1, 3], "group": "cg_upper"}]}
    parsed = EditSpec.model_validate(spec)
    assert parsed.sequence.clips[0].group == "cg_main"
    assert parsed.video_tracks[0].clips[0].group == "cg_upper"
    assert parsed.layers[0].group == "cg_main"
    assert parsed.audio.tracks[0].group == "cg_upper"
    assert EditSpec.model_validate(sequence_spec(clip("c1", "v1"))).sequence.clips[0].group is None
    with pytest.raises(ValueError):
        EditSpec.model_validate(sequence_spec({**clip("c1", "v1"), "group": "g" * 65}))

    saved = client.put(f"/api/videos/{ready_video.id}/spec", json={"edit_spec": spec})
    assert saved.status_code == 200, saved.text
    reopened = client.get(f"/api/videos/{ready_video.id}").json()["edit_spec"]
    assert reopened["sequence"]["clips"][0]["group"] == "cg_main"
    assert reopened["video_tracks"][0]["clips"][0]["group"] == "cg_upper"
    assert reopened["layers"][0]["group"] == "cg_main"
    assert reopened["audio"]["tracks"][0]["group"] == "cg_upper"

    plain = {"spec_version": 1, "trim": {"remove": [[2, 3]], "splits": [1.5, 6]}, "layers": [], "outputs": spec["outputs"]}
    assert EditSpec.model_validate(plain, context={"duration": 24.6}).trim.splits == [1.5, 6]
    saved = client.put(f"/api/videos/{ready_video.id}/spec", json={"edit_spec": plain})
    assert saved.status_code == 200, saved.text
    assert client.get(f"/api/videos/{ready_video.id}").json()["edit_spec"]["trim"]["splits"] == [1.5, 6]
    with pytest.raises(ValueError):
        EditSpec.model_validate({**plain, "trim": {"remove": [], "splits": [-1]}})
