"""ensure_columns(): adding a model column must not break an existing database.

create_all never alters an existing table, and the prototype server keeps its SQLite
file in a persistent volume — without this, every query on `assets` would fail with
"no such column" right after a deploy that adds a field.
"""

from __future__ import annotations

import sqlalchemy as sa

from app.db import Base, ensure_columns, engine


def _columns(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(engine).get_columns(table)}


def test_ensure_columns_adds_a_missing_column_and_is_idempotent():
    expected = {c.name for c in Base.metadata.tables["assets"].columns}
    assert expected <= _columns("assets")

    # Simulate a database created before the video-sticker columns existed.
    with engine.begin() as conn:
        conn.execute(sa.text("ALTER TABLE assets DROP COLUMN has_alpha"))
    assert "has_alpha" not in _columns("assets")

    ensure_columns()
    assert "has_alpha" in _columns("assets")

    # Running it again changes nothing and must not raise "duplicate column".
    ensure_columns()
    assert expected <= _columns("assets")


def test_ensure_columns_restores_a_defaulted_column_with_usable_rows():
    with engine.begin() as conn:
        conn.execute(sa.text("ALTER TABLE assets DROP COLUMN kind"))
    ensure_columns()
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO assets (id, type, name, ext, source, status, created_at)"
                " VALUES ('a_mig1', 'sticker', 'x.png', 'png', 'upload', 'ready', '2026-01-01')"
            )
        )
        kind = conn.execute(sa.text("SELECT kind FROM assets WHERE id = 'a_mig1'")).scalar()
        conn.execute(sa.text("DELETE FROM assets WHERE id = 'a_mig1'"))
    assert kind == "image"  # the DEFAULT came along with the ALTER


def test_ensure_columns_adds_the_video_localization_column():
    """Databases from before 改语言 have no ``videos.localization``; startup must add it."""
    with engine.begin() as conn:
        conn.execute(sa.text("ALTER TABLE videos DROP COLUMN localization"))
    assert "localization" not in _columns("videos")
    ensure_columns()
    assert "localization" in _columns("videos")
    ensure_columns()
    assert {c.name for c in Base.metadata.tables["videos"].columns} <= _columns("videos")
