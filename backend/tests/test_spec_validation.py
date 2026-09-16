import pytest
from pydantic import ValidationError

from app.schemas import CANVAS_SIZES, EditSpec, LayerOverride, MaskLayer, StickerLayer, TextLayer, empty_spec
from tests.conftest import valid_spec


def validate(spec, duration=24.6):
    return EditSpec.model_validate(spec, context={"duration": duration})


def errors_of(spec, duration=24.6) -> str:
    with pytest.raises(ValidationError) as info:
        validate(spec, duration)
    return str(info.value)


def test_contract_example_is_valid():
    spec = validate(valid_spec())
    assert spec.spec_version == 1
    assert spec.trim.remove == [(3.2, 5.8), (17.0, 18.4)]
    assert isinstance(spec.layers[0], StickerLayer)
    assert isinstance(spec.layers[1], TextLayer)
    assert spec.layers[0].t == (0.0, 6.0)
    assert spec.layers[1].t == "all"
    assert spec.outputs[1].layer_overrides["l_1"].as_dict() == {"margin": (0.05, 0.05), "width": 0.3}
    assert spec.outputs[0].canvas == (1080, 1920)


def test_canvas_sizes():
    assert CANVAS_SIZES == {"9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350), "16:9": (1920, 1080)}


def test_defaults_fill_in():
    spec = validate({"outputs": [{"variant_key": "9x16", "aspect": "9:16"}]})
    assert spec.trim.remove == [] and spec.layers == []
    assert spec.outputs[0].fill == "blur" and spec.outputs[0].color == "#000000"


def test_extra_keys_are_ignored_but_override_keys_are_strict():
    spec = valid_spec()
    spec["ui_note"] = "x"
    spec["layers"][0]["name"] = "贴纸"
    validate(spec)
    spec["outputs"][1]["layer_overrides"]["l_1"]["asset_id"] = "a_other"
    assert "asset_id" in errors_of(spec)


@pytest.mark.parametrize(
    "remove,fragment",
    [
        ([[5, 3]], "终点必须大于起点"),
        ([[-1, 3]], "不能小于 0"),
        ([[1, 5], [4, 8]], "重叠"),
        ([[10, 12], [1, 2]], "升序"),
        ([[1, 2], [20, 30]], "超出视频时长"),
        ([[0, 24.6]], "整条视频"),
    ],
)
def test_trim_rules(remove, fragment):
    assert fragment in errors_of(valid_spec(trim={"remove": remove}))


def test_trim_touching_ranges_are_allowed():
    validate(valid_spec(trim={"remove": [[1, 2], [2, 3]]}))


def test_trim_duration_check_skipped_without_context():
    EditSpec.model_validate(valid_spec(trim={"remove": [[1, 2], [20, 30]]}))


def test_requires_at_least_one_output():
    assert "outputs" in errors_of(valid_spec(outputs=[]))
    with pytest.raises(ValidationError):
        EditSpec.model_validate(empty_spec())


def test_variant_keys_unique_and_well_formed():
    spec = valid_spec(outputs=[{"variant_key": "9x16", "aspect": "9:16"}, {"variant_key": "9x16", "aspect": "1:1"}])
    assert "variant_key 重复" in errors_of(spec)
    spec = valid_spec(outputs=[{"variant_key": "bad key!", "aspect": "9:16"}])
    assert "variant_key" in errors_of(spec)


def test_output_quality_defaults_and_enum():
    spec = validate(valid_spec())
    assert all(o.quality == "standard" for o in spec.outputs)
    spec = validate(valid_spec(outputs=[{"variant_key": "x", "aspect": "9:16", "quality": "high"}]))
    assert spec.outputs[0].quality == "high"
    assert "quality" in errors_of(valid_spec(outputs=[{"variant_key": "x", "aspect": "9:16", "quality": "ultra"}]))


def test_text_style_shadow_and_letter_spacing():
    spec = valid_spec()
    spec["layers"][1]["style"].update({"shadow": {"color": "#00000080", "blur": 0.01, "offset": [0.002, 0.004]}, "letter_spacing": 0.05})
    style = validate(spec).layers[1].style
    assert style.shadow.color == "#00000080" and style.shadow.blur == 0.01 and style.shadow.offset == (0.002, 0.004)
    assert style.letter_spacing == 0.05
    spec["layers"][1]["style"]["shadow"] = None
    assert validate(spec).layers[1].style.shadow is None
    spec["layers"][1]["style"]["shadow"] = {"blur": -1}
    assert "shadow" in errors_of(spec)


def test_text_style_glow():
    spec = valid_spec()
    spec["layers"][1]["style"]["glow"] = {"color": "#FF7A1ACC", "blur": 0.014}
    style = validate(spec).layers[1].style
    assert style.glow.color == "#FF7A1ACC" and style.glow.blur == 0.014
    spec["layers"][1]["style"]["glow"] = None
    assert validate(spec).layers[1].style.glow is None
    del spec["layers"][1]["style"]["glow"]
    assert validate(spec).layers[1].style.glow is None
    spec["layers"][1]["style"]["glow"] = {"color": "#FFFFFF", "blur": -0.01}
    assert "glow" in errors_of(spec)


def test_text_spans_and_background_fields():
    spec = valid_spec()
    layer = spec["layers"][1]
    layer["spans"] = [{"start": 0, "end": 2, "color": "#E3312B"}, {"start": 2, "end": 4, "color": "#111111"}]
    layer["style"].update({"background": "#F7D308FF", "background_width": 1.0, "background_radius": 0})
    out = validate(spec).layers[1]
    assert [(s.start, s.end, s.color) for s in out.spans] == [(0, 2, "#E3312B"), (2, 4, "#111111")]
    assert out.style.background_width == 1.0 and out.style.background_radius == 0
    # defaults: old specs without the fields still validate
    plain = validate(valid_spec()).layers[1]
    assert plain.spans is None and plain.style.background_width is None and plain.style.background_radius is None
    # overlapping / inverted ranges
    layer["spans"] = [{"start": 0, "end": 3, "color": "#E3312B"}, {"start": 2, "end": 4, "color": "#111111"}]
    assert "spans" in errors_of(spec)
    layer["spans"] = [{"start": 3, "end": 3, "color": "#E3312B"}]
    assert "spans" in errors_of(spec)
    layer["spans"] = None
    layer["style"]["background_width"] = 1.5
    assert "background_width" in errors_of(spec)
    layer["style"]["background_width"] = 0.98
    layer["style"]["background_radius"] = -0.01
    assert "background_radius" in errors_of(spec)


def test_aspect_and_fill_enums():
    assert "aspect" in errors_of(valid_spec(outputs=[{"variant_key": "x", "aspect": "3:4"}]))
    assert "fill" in errors_of(valid_spec(outputs=[{"variant_key": "x", "aspect": "9:16", "fill": "stretch"}]))
    assert "color" in errors_of(valid_spec(outputs=[{"variant_key": "x", "aspect": "9:16", "fill": "color", "color": "red"}]))


def test_crop_window_is_optional_and_bounded():
    def out(crop):
        return valid_spec(outputs=[{"variant_key": "x", "aspect": "9:16", "fill": "crop", "crop": crop}])

    assert validate(valid_spec()).outputs[0].crop is None
    rect = validate(out({"x": 0.3418, "y": 0, "w": 0.3164, "h": 1})).outputs[0].crop
    assert (rect.x, rect.y, rect.w, rect.h) == (0.3418, 0, 0.3164, 1)
    assert validate(out({"w": 0.5, "h": 0.5})).outputs[0].crop.x == 0  # x / y 默认 0
    assert "crop" in errors_of(out({"x": 0.6, "y": 0, "w": 0.5, "h": 1}))  # x + w > 1
    assert "crop" in errors_of(out({"x": 0, "y": 0.5, "w": 1, "h": 0.6}))  # y + h > 1
    assert "crop" in errors_of(out({"x": 0, "y": 0, "w": 0, "h": 1}))  # w 必须 > 0
    assert "crop" in errors_of(out({"x": -0.1, "y": 0, "w": 0.5, "h": 1}))
    # 非 crop 填充下带窗口也能通过校验（worker 忽略）
    assert validate(valid_spec(outputs=[{"variant_key": "x", "aspect": "9:16", "fill": "blur", "crop": {"w": 0.5, "h": 1}}])).outputs[0].crop is not None


def test_anchor_enum_and_geometry_ranges():
    spec = valid_spec()
    spec["layers"][0]["anchor"] = "middle"
    assert "anchor" in errors_of(spec)
    spec = valid_spec()
    spec["layers"][0]["width"] = 0
    assert "width" in errors_of(spec)
    spec = valid_spec()
    spec["layers"][0]["opacity"] = 1.5
    assert "opacity" in errors_of(spec)


def test_layer_type_discriminator():
    spec = valid_spec()
    spec["layers"][0]["type"] = "gif"
    assert "type" in errors_of(spec)
    spec = valid_spec()
    del spec["layers"][0]["asset_id"]
    assert "asset_id" in errors_of(spec)


def test_layer_time_window():
    spec = valid_spec()
    spec["layers"][0]["t"] = [5, 2]
    assert "终点必须大于起点" in errors_of(spec)
    spec["layers"][0]["t"] = [-1, 2]
    assert "不能小于 0" in errors_of(spec)


def test_duplicate_layer_ids():
    spec = valid_spec()
    spec["layers"][1]["id"] = "l_1"
    assert "图层 id 重复" in errors_of(spec)


def test_text_layer_image_url_must_be_media_path():
    spec = valid_spec()
    spec["layers"][1]["image_url"] = "https://evil.example/x.png"
    assert "image_url" in errors_of(spec)
    spec["layers"][1]["image_url"] = None
    validate(spec)  # optional: the worker skips it with a warning


def test_spec_version_must_be_1():
    assert "spec_version" in errors_of(valid_spec(spec_version=2))


def test_layer_override_as_dict_drops_none():
    assert LayerOverride(width=0.2).as_dict() == {"width": 0.2}


def test_sticker_playback_defaults_and_validates():
    spec = valid_spec()
    assert "playback" not in spec["layers"][0]
    assert validate(spec).layers[0].playback == "loop"  # old specs keep working

    for mode in ("loop", "freeze", "once"):
        spec["layers"][0]["playback"] = mode
        assert validate(spec).layers[0].playback == mode

    spec["layers"][0]["playback"] = "rewind"
    assert "playback" in errors_of(spec)


# --- audio (contract §2 audio) ------------------------------------------------------


def audio_spec(**audio):
    spec = valid_spec()
    spec["audio"] = {"source_volume": 1, "tracks": [], **audio}
    return spec


def test_audio_block_is_optional_and_defaults_fill_in():
    assert validate(valid_spec()).audio is None
    spec = validate(audio_spec(tracks=[{"id": "au_1", "asset_id": "a_bgm"}]))
    assert spec.audio.source_volume == 1.0
    track = spec.audio.tracks[0]
    assert (track.role, track.t, track.offset, track.volume, track.loop, track.fade_in, track.fade_out) == (
        "bgm", "all", 0.0, 1.0, False, 0.0, 0.0
    )
    spec = validate(audio_spec(source_volume=0, tracks=[{"id": "au_1", "asset_id": "a_v", "role": "voice", "t": [1, 4], "offset": 0.5, "volume": 0.7, "fade_in": 1, "fade_out": 2}]))
    assert spec.audio.source_volume == 0 and spec.audio.tracks[0].t == (1.0, 4.0)


@pytest.mark.parametrize(
    "audio,fragment",
    [
        ({"source_volume": 1.5}, "source_volume"),
        ({"source_volume": -0.1}, "source_volume"),
        ({"tracks": [{"id": "a", "asset_id": "x", "volume": 2}]}, "volume"),
        ({"tracks": [{"id": "a", "asset_id": "x", "offset": -1}]}, "offset"),
        ({"tracks": [{"id": "a", "asset_id": "x", "t": [5, 3]}]}, "终点必须大于起点"),
        ({"source_mute": [[-1, 2]]}, "起点不能小于 0"),
        ({"source_mute": [[3, 3]]}, "终点必须大于起点"),
        ({"source_mute": [[4, 6], [5, 7]]}, "重叠或未按升序排列"),
        ({"source_mute": [[4, 6], [1, 2]]}, "重叠或未按升序排列"),
        ({"tracks": [{"id": "a", "asset_id": "x", "t": [0, 3], "fade_in": 2, "fade_out": 2}]}, "淡入加淡出不能超过时段长度"),
        ({"tracks": [{"id": "a", "asset_id": "x"}, {"id": "a", "asset_id": "y"}]}, "音轨 id 重复"),
        ({"tracks": [{"id": "a", "asset_id": ""}]}, "asset_id"),
        ({"tracks": [{"id": "a", "asset_id": "x", "role": "sfx"}]}, "role"),
    ],
)
def test_audio_rules(audio, fragment):
    assert fragment in errors_of(audio_spec(**audio))


def test_source_mute_defaults_empty_and_keeps_sorted_spans():
    assert validate(audio_spec()).audio.source_mute == []
    spec = validate(audio_spec(source_mute=[[1, 2.5], [2.5, 4], [10, 99]]))  # touching is fine; no upper bound
    assert spec.audio.source_mute == [(1.0, 2.5), (2.5, 4.0), (10.0, 99.0)]


def test_looping_track_may_start_mid_file():
    """HIG-25: the second half of a split looping BGM continues from where the first half stopped."""
    track = validate(audio_spec(tracks=[{"id": "a", "asset_id": "x", "loop": True, "offset": 2.5}])).audio.tracks[0]
    assert track.loop and track.offset == 2.5


def test_audio_fades_may_fill_the_window_exactly_and_all_windows_skip_the_sum_check():
    validate(audio_spec(tracks=[{"id": "a", "asset_id": "x", "t": [0, 3], "fade_in": 1.5, "fade_out": 1.5}]))
    validate(audio_spec(tracks=[{"id": "a", "asset_id": "x", "t": "all", "fade_in": 30, "fade_out": 30}]))


# --- cover (HIG-9) -------------------------------------------------------------------


def test_cover_is_optional_and_duration_defaults_to_one_second():
    assert validate(valid_spec()).cover is None
    spec = validate(valid_spec(cover={"asset_id": "a_cover"}))
    assert spec.cover.asset_id == "a_cover" and spec.cover.duration == 1.0
    assert validate(valid_spec(cover=None)).cover is None


@pytest.mark.parametrize(
    "cover,fragment",
    [
        ({"asset_id": ""}, "asset_id"),
        ({}, "asset_id"),
        ({"asset_id": "a", "duration": 0.05}, "duration"),
        ({"asset_id": "a", "duration": 10.5}, "duration"),
    ],
)
def test_cover_rules(cover, fragment):
    assert fragment in errors_of(valid_spec(cover=cover))


def test_audio_track_align_source_forbids_loop_and_offset():
    spec = validate(audio_spec(tracks=[{"id": "a", "asset_id": "x", "align": "source", "t": [1, 4], "fade_out": 1}]))
    assert spec.audio.tracks[0].align == "source"
    assert validate(audio_spec(tracks=[{"id": "a", "asset_id": "x"}])).audio.tracks[0].align == "post"
    assert "对齐源时间轴" in errors_of(audio_spec(tracks=[{"id": "a", "asset_id": "x", "align": "source", "loop": True}]))
    assert "对齐源时间轴" in errors_of(audio_spec(tracks=[{"id": "a", "asset_id": "x", "align": "source", "offset": 2}]))
    assert "align" in errors_of(audio_spec(tracks=[{"id": "a", "asset_id": "x", "align": "sideways"}]))


# --- mask layers (contract §2 type = "mask") ------------------------------------------


def mask_spec(**mask):
    spec = valid_spec()
    spec["layers"].insert(1, {"id": "l_m", "type": "mask", "anchor": "bottom-center", "margin": [0, 0.1], "width": 1.0, **mask})
    return spec


def test_mask_layer_defaults_fill_in():
    layer = validate(mask_spec()).layers[1]
    assert isinstance(layer, MaskLayer)
    assert (layer.height, layer.mode, layer.blur, layer.color) == (0.12, "blur", 2, "#000000")
    assert (layer.width, layer.rotate, layer.opacity, layer.t) == (1.0, 0.0, 1.0, "all")
    layer = validate(mask_spec(height=0.2, mode="solid", blur=3, color="#a1B2c3", opacity=0.5, t=[1, 4])).layers[1]
    assert (layer.height, layer.mode, layer.blur, layer.color, layer.opacity, layer.t) == (0.2, "solid", 3, "#a1B2c3", 0.5, (1.0, 4.0))


@pytest.mark.parametrize(
    "mask,fragment",
    [
        ({"mode": "pixelate"}, "mode"),
        ({"color": "#00000080"}, "color 必须是 #RRGGBB"),
        ({"color": "black"}, "color 必须是 #RRGGBB"),
        ({"blur": 0}, "blur"),
        ({"blur": 4}, "blur"),
        ({"height": 1.5}, "height"),
        ({"height": 0}, "height"),
    ],
)
def test_mask_rules(mask, fragment):
    assert fragment in errors_of(mask_spec(**mask))


def test_layer_override_height():
    spec = mask_spec()
    spec["outputs"][1]["layer_overrides"]["l_m"] = {"height": 0.2, "width": 0.8}
    out = validate(spec)
    assert out.outputs[1].layer_overrides["l_m"].as_dict() == {"width": 0.8, "height": 0.2}
    spec["outputs"][1]["layer_overrides"]["l_m"] = {"height": 1.2}
    assert "height" in errors_of(spec)
    assert LayerOverride(height=0.3).as_dict() == {"height": 0.3}


def test_layer_fit_is_optional_and_enumerated():
    spec = valid_spec()
    assert EditSpec.model_validate(spec).outputs[1].layer_fit == "canvas"
    spec["outputs"][1]["layer_fit"] = "video"
    assert EditSpec.model_validate(spec).outputs[1].layer_fit == "video"
    spec["outputs"][1]["layer_fit"] = "frame"
    with pytest.raises(ValidationError):
        EditSpec.model_validate(spec)
