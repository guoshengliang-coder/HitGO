"""Batch apply of edit_spec modules (contract §3, POST /api/batches/{id}/apply).

Rules: deep-copy the chosen modules (trim | layers | outputs | audio) from the source spec
into each target; a target without a spec first gets an empty spec; when applying
``trim`` to a shorter target, ranges past its duration are dropped / clamped.

``layer_mode`` refines how the ``layers`` module is applied:

- ``replace`` (default): the target's layer list becomes a deep copy of the source's.
- ``style_only``: each source layer is matched to a target layer (same ``id``; for
  text layers, falling back to the first target text layer with identical ``text``).
  A matched target keeps its own ``anchor`` / ``margin`` / ``t`` (and any other keys)
  and only takes the source's type-specific fields (for text: ``text`` together with
  its ``spans``) plus ``width`` / ``rotate`` / ``opacity``. Unmatched source layers are
  appended as deep copies.
"""

from __future__ import annotations

import copy
from typing import Any

from app.schemas import empty_spec

MODULES = ("trim", "layers", "outputs", "audio")
LAYER_MODES = ("replace", "style_only")

# Keys copied from source → matched target in style_only mode, by layer type.
_STYLE_KEYS_COMMON = ("width", "rotate", "opacity")
_STYLE_KEYS_BY_TYPE: dict[str, tuple[str, ...]] = {
    "sticker": ("asset_id", "playback", "mix_audio"),
    "text": ("text", "spans", "style", "image_url", "image_size"),
}


def clamp_remove_ranges(
    remove: list[list[float]] | list[tuple[float, float]], duration: float | None
) -> list[list[float]]:
    """Drop ranges starting at/after `duration`; clamp ones that cross it."""
    result: list[list[float]] = []
    for pair in remove:
        a, b = float(pair[0]), float(pair[1])
        if duration is not None:
            if a >= duration:
                continue
            b = min(b, duration)
        if b > a:
            result.append([a, b])
    return result


def _match_target_layer(
    source: dict[str, Any], targets: list[dict[str, Any]], taken: set[int]
) -> int | None:
    """Index of the target layer that `source` maps onto, or None."""
    for i, t in enumerate(targets):
        if i not in taken and t.get("id") == source.get("id"):
            return i
    if source.get("type") == "text":
        for i, t in enumerate(targets):
            if i in taken or t.get("type") != "text":
                continue
            if t.get("text") == source.get("text"):
                return i
    return None


def merge_layers_style_only(
    source_layers: list[dict[str, Any]], target_layers: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Return the target's new layer list (fresh dicts; inputs are not mutated)."""
    result = copy.deepcopy(target_layers)
    taken: set[int] = set()
    for src in source_layers:
        idx = _match_target_layer(src, result, taken)
        if idx is None:
            result.append(copy.deepcopy(src))
            continue
        taken.add(idx)
        dst = result[idx]
        keys = _STYLE_KEYS_BY_TYPE.get(str(src.get("type")), ()) + _STYLE_KEYS_COMMON
        for key in keys:
            if key in src:
                dst[key] = copy.deepcopy(src[key])
            else:
                dst.pop(key, None)
    return result


def apply_modules(
    source_spec: dict[str, Any],
    target_spec: dict[str, Any] | None,
    modules: list[str],
    target_duration: float | None,
    layer_mode: str = "replace",
) -> dict[str, Any]:
    """Return the target's new spec (a fresh dict; inputs are not mutated)."""
    if layer_mode not in LAYER_MODES:
        raise ValueError(f"未知图层套用方式：{layer_mode}")
    result = copy.deepcopy(target_spec) if target_spec else empty_spec()
    result.setdefault("spec_version", 1)

    for module in modules:
        if module not in MODULES:
            raise ValueError(f"未知模块：{module}")
        if module == "trim":
            source_remove = (source_spec.get("trim") or {}).get("remove") or []
            result["trim"] = {"remove": clamp_remove_ranges(source_remove, target_duration)}
        elif module == "layers":
            source_layers = source_spec.get("layers") or []
            if layer_mode == "style_only":
                result["layers"] = merge_layers_style_only(source_layers, result.get("layers") or [])
            else:
                result["layers"] = copy.deepcopy(source_layers)
        elif module == "outputs":
            result["outputs"] = copy.deepcopy(source_spec.get("outputs") or [])
        elif module == "audio":
            # Whole block, or none: a source without audio settings clears the target's.
            audio = source_spec.get("audio")
            if audio is None:
                result.pop("audio", None)
            else:
                result["audio"] = copy.deepcopy(audio)

    result.setdefault("trim", {"remove": []})
    result.setdefault("layers", [])
    result.setdefault("outputs", [])
    return result
