import pytest
from pydantic import ValidationError

from app.schemas import CANVAS_SIZES, EditSpec, LayerOverride, StickerLayer, TextLayer, empty_spec
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
