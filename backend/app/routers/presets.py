"""Presets: GET/POST/DELETE /api/presets (saved text styles etc., contract §3)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import ids
from app.db import get_db, iso
from app.models import Preset
from app.schemas import PRESET_TYPES, PresetIn, PresetOut

router = APIRouter(prefix="/api/presets", tags=["presets"])


def preset_out(preset: Preset) -> PresetOut:
    return PresetOut(
        id=preset.id,
        type=preset.type,
        name=preset.name,
        data=preset.data or {},
        created_at=iso(preset.created_at) or "",
    )


@router.get("", response_model=list[PresetOut])
def list_presets(
    type: str = Query(..., description="预设类型，目前只有 text_style"),
    db: Session = Depends(get_db),
) -> list[PresetOut]:
    if type not in PRESET_TYPES:
        raise HTTPException(400, f"type 必须是 {' | '.join(sorted(PRESET_TYPES))}")
    stmt = (
        select(Preset)
        .where(Preset.type == type)
        .order_by(Preset.created_at.desc(), Preset.id.desc())
    )
    return [preset_out(p) for p in db.scalars(stmt).all()]


@router.post("", response_model=PresetOut, status_code=201)
def create_preset(body: PresetIn, db: Session = Depends(get_db)) -> PresetOut:
    preset = Preset(id=ids.preset_id(), type=body.type, name=body.name, data=body.data)
    db.add(preset)
    db.commit()
    return preset_out(preset)


@router.delete("/{preset_id}", status_code=204)
def delete_preset(preset_id: str, db: Session = Depends(get_db)) -> None:
    preset = db.get(Preset, preset_id)
    if preset is None:
        raise HTTPException(404, "预设不存在")
    db.delete(preset)
    db.commit()
