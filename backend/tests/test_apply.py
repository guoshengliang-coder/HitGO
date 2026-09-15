import copy

import pytest

from app.services.apply import apply_modules, clamp_remove_ranges, merge_layers_style_only
from tests.conftest import valid_spec


def _target_with_layers():
    """Target spec whose two layers share ids with valid_spec() but sit elsewhere / at other times."""
    return {
        "spec_version": 1,
        "trim": {"remove": []},
        "layers": [
            {"id": "l_1", "type": "sticker", "asset_id": "a_old", "anchor": "bottom-right", "margin": [0.02, 0.03],
             "width": 0.2, "rotate": 10, "opacity": 0.8, "t": [2, 9], "ui_color": "#abc"},
            {"id": "l_2", "type": "text", "text": "旧文案", "style": {"color": "#FF0000"}, "image_url": "/media/uploads/u_old.png",
             "image_size": [100, 40], "anchor": "center", "margin": [0.1, 0.2], "width": 0.4, "t": [1, 3]},
        ],
        "outputs": [{"variant_key": "9x16", "aspect": "9:16"}],
    }


def test_clamp_remove_ranges():
    ranges = [[1, 2], [8, 12], [15, 20]]
    assert clamp_remove_ranges(ranges, 10) == [[1, 2], [8, 10]]
    assert clamp_remove_ranges(ranges, None) == [[1, 2], [8, 12], [15, 20]]
    assert clamp_remove_ranges([[10, 12]], 10) == []


def test_apply_to_empty_target_creates_empty_spec_then_copies():
    src = valid_spec()
    out = apply_modules(src, None, ["trim"], 30.0)
    assert out["spec_version"] == 1
    assert out["trim"] == {"remove": [[3.2, 5.8], [17.0, 18.4]]}
    assert out["layers"] == [] and out["outputs"] == []


def test_apply_trim_drops_ranges_beyond_shorter_target():
    out = apply_modules(valid_spec(), None, ["trim"], 10.0)
    assert out["trim"]["remove"] == [[3.2, 5.8]]
    out = apply_modules(valid_spec(), None, ["trim"], 17.5)
    assert out["trim"]["remove"] == [[3.2, 5.8], [17.0, 17.5]]


def test_apply_layers_and_outputs_are_deep_copies():
    src = valid_spec()
    target = {"spec_version": 1, "trim": {"remove": [[1, 2]]}, "layers": [], "outputs": [{"variant_key": "k", "aspect": "1:1"}]}
    out = apply_modules(src, target, ["layers", "outputs"], 24.6)
    assert out["trim"] == {"remove": [[1, 2]]}  # untouched module
    assert out["layers"] == src["layers"] and out["layers"] is not src["layers"]
    assert out["outputs"] == src["outputs"]
    out["layers"][0]["id"] = "changed"
    assert src["layers"][0]["id"] == "l_1"
    assert target["outputs"][0]["variant_key"] == "k"  # input not mutated


def test_apply_all_modules():
    out = apply_modules(valid_spec(), {"spec_version": 1, "layers": [{"id": "old"}]}, ["trim", "layers", "outputs"], 24.6)
    assert out["layers"][0]["id"] == "l_1"
    assert len(out["outputs"]) == 2


def test_unknown_module():
    with pytest.raises(ValueError):
        apply_modules(valid_spec(), None, ["audio"], 10)


def test_unknown_layer_mode():
    with pytest.raises(ValueError):
        apply_modules(valid_spec(), None, ["layers"], 10, layer_mode="merge")


# --- layer_mode ----------------------------------------------------------------


def test_replace_mode_is_default_and_unchanged():
    src, target = valid_spec(), _target_with_layers()
    assert apply_modules(src, target, ["layers"], 24.6)["layers"] == src["layers"]
    assert apply_modules(src, target, ["layers"], 24.6, "replace")["layers"] == src["layers"]


def test_style_only_same_id_keeps_target_position_and_time_but_takes_style():
    src, target = valid_spec(), _target_with_layers()
    snapshot = copy.deepcopy(target)
    out = apply_modules(src, target, ["layers"], 24.6, "style_only")
    assert target == snapshot  # input not mutated
    assert [l["id"] for l in out["layers"]] == ["l_1", "l_2"]

    sticker, text = out["layers"]
    # sticker: new asset + width/rotate/opacity, target's anchor/margin/t and extra keys
    assert sticker["asset_id"] == "a_sticker001"
    assert (sticker["width"], sticker["rotate"], sticker["opacity"]) == (0.35, 0, 1)
    assert sticker["anchor"] == "bottom-right" and sticker["margin"] == [0.02, 0.03] and sticker["t"] == [2, 9]
    assert sticker["ui_color"] == "#abc"
    # text: new text/style/image, target's anchor/margin/t
    assert text["text"] == "限时免费" and text["style"] == src["layers"][1]["style"]
    assert text["image_url"] == "/media/uploads/u_text00001.png" and text["image_size"] == [540, 130]
    assert text["anchor"] == "center" and text["margin"] == [0.1, 0.2] and text["t"] == [1, 3]
    assert text["width"] == 0.5
    # deep copies: editing the result never touches the source
    text["style"]["color"] = "#000"
    assert src["layers"][1]["style"]["color"] == "#FFFFFF"


def test_style_only_spans_follow_text():
    src, target = valid_spec(), _target_with_layers()
    src["layers"][1]["spans"] = [{"start": 0, "end": 2, "color": "#E3312B"}]
    target["layers"][1]["spans"] = [{"start": 1, "end": 2, "color": "#00FF00"}]
    out = apply_modules(src, target, ["layers"], 24.6, "style_only")
    assert out["layers"][1]["spans"] == [{"start": 0, "end": 2, "color": "#E3312B"}]
    # a source without spans clears the target's: they belong to the source text
    del src["layers"][1]["spans"]
    out = apply_modules(src, target, ["layers"], 24.6, "style_only")
    assert "spans" not in out["layers"][1]


def test_style_only_text_falls_back_to_identical_text_match():
    src = valid_spec()
    src["layers"][1]["id"] = "l_new"  # id no longer matches …
    target = _target_with_layers()
    target["layers"][1]["text"] = "限时免费"  # … but the text does
    out = apply_modules(src, target, ["layers"], 24.6, "style_only")
    ids = [l["id"] for l in out["layers"]]
    assert ids == ["l_1", "l_2"]  # matched target keeps its own id, nothing appended
    text = out["layers"][1]
    assert text["style"] == src["layers"][1]["style"] and text["anchor"] == "center" and text["t"] == [1, 3]


def test_style_only_unmatched_layers_are_appended():
    src = valid_spec()
    src["layers"][0]["id"] = "l_9"  # sticker has no id match (stickers never fall back to text)
    src["layers"][1]["id"] = "l_8"  # text: neither id nor text matches
    target = _target_with_layers()
    out = apply_modules(src, target, ["layers"], 24.6, "style_only")
    assert [l["id"] for l in out["layers"]] == ["l_1", "l_2", "l_9", "l_8"]
    assert out["layers"][0] == target["layers"][0]  # untouched
    assert out["layers"][2] == src["layers"][0] and out["layers"][2] is not src["layers"][0]


def test_style_only_into_empty_target_appends_everything():
    out = apply_modules(valid_spec(), None, ["layers"], 24.6, "style_only")
    assert out["layers"] == valid_spec()["layers"]


def test_style_only_removes_type_fields_absent_from_source():
    src = [{"id": "l_2", "type": "text", "text": "a", "width": 0.3}]
    target = [{"id": "l_2", "type": "text", "text": "b", "image_url": "/media/uploads/u_old.png", "image_size": [1, 1], "anchor": "center"}]
    (out,) = merge_layers_style_only(src, target)
    assert out["text"] == "a" and out["width"] == 0.3 and out["anchor"] == "center"
    assert "image_url" not in out and "image_size" not in out  # stale PNG is not kept for new text


def test_style_only_each_target_matched_once():
    src = [{"id": "x", "type": "text", "text": "同", "style": {"color": "#1"}},
           {"id": "y", "type": "text", "text": "同", "style": {"color": "#2"}}]
    target = [{"id": "t", "type": "text", "text": "同", "anchor": "center"}]
    out = merge_layers_style_only(src, target)
    assert [l["id"] for l in out] == ["t", "y"] and out[0]["style"] == {"color": "#1"}


def test_style_only_copies_playback_with_the_asset():
    src, target = valid_spec(), _target_with_layers()
    src["layers"][0]["playback"] = "once"
    out = apply_modules(src, target, ["layers"], 24.6, "style_only")
    assert out["layers"][0]["playback"] == "once"

    # playback belongs to the source sticker, so a source without it clears the target's
    del src["layers"][0]["playback"]
    target["layers"][0]["playback"] = "freeze"
    out = apply_modules(src, target, ["layers"], 24.6, "style_only")
    assert "playback" not in out["layers"][0]
