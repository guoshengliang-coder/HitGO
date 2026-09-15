"""SQLAlchemy engine / session setup. SQLite by default, PostgreSQL via DATABASE_URL."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


def _make_engine():
    kwargs: dict = {"pool_pre_ping": True}
    if settings.is_sqlite:
        # The API serves requests from a thread pool; the worker opens its own sessions.
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
    engine = create_engine(settings.database_url, **kwargs)
    if settings.is_sqlite:

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _record):  # noqa: ANN001
            cursor = dbapi_conn.cursor()
            # WAL lets the API read while the worker writes progress.
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=30000")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return engine


engine = _make_engine()
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)


def init_db() -> None:
    from app import models  # noqa: F401  (register tables)

    if settings.is_sqlite and settings.database_url.startswith("sqlite:///"):
        db_path = settings.database_url.removeprefix("sqlite:///")
        if db_path and db_path != ":memory:":
            from pathlib import Path

            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(engine)
    ensure_columns()


def ensure_columns() -> None:
    """Add columns that exist on the models but not yet in an already-created table.

    ``create_all`` never alters an existing table, and the prototype server keeps its
    database in a persistent volume — without this, adding a column to a model makes
    every query on that table fail with "no such column" after a deploy.
    Idempotent, and limited to nullable / defaulted columns (the only kind the
    contract allows to be added). SQLite and PostgreSQL both take this ALTER form.
    """
    with engine.begin() as conn:
        # Reflect through the live connection: an Inspector built from the engine can
        # hand back cached metadata and we would ALTER a column that already exists.
        inspector = inspect(conn)
        existing_tables = set(inspector.get_table_names())
        for table in Base.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue  # create_all just made it, with every column
            present = {c["name"] for c in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in present or column.primary_key:
                    continue
                ddl = f"ALTER TABLE {table.name} ADD COLUMN {column.name} "
                ddl += column.type.compile(engine.dialect)
                default = column.default
                if default is not None and not callable(getattr(default, "arg", None)):
                    literal = default.arg
                    if isinstance(literal, str):
                        literal = "'" + literal.replace("'", "''") + "'"
                    elif isinstance(literal, bool):
                        literal = "1" if literal else "0"
                    ddl += f" DEFAULT {literal}"
                conn.execute(text(ddl))


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def utcnow() -> datetime:
    """Naive UTC timestamp (stored without tz so SQLite and PostgreSQL behave alike)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.isoformat(timespec="seconds") + "Z"
