"""Read tickets for one /media file (contract §0, HIG-58)."""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services import media_ticket

CODE = "secret"
REL = "voice-samples/v_abc.m4a"


def test_ticket_round_trip():
    ticket = media_ticket.issue(REL, CODE, 600)
    assert media_ticket.verify(REL, ticket, CODE)


def test_ticket_is_bound_to_one_path():
    """A leaked ticket must not become a key to the rest of /media."""
    ticket = media_ticket.issue(REL, CODE, 600)
    assert not media_ticket.verify("voice-samples/v_other.m4a", ticket, CODE)
    assert not media_ticket.verify("assets/a_x.m4a", ticket, CODE)


def test_ticket_expires():
    now = time.time()
    ticket = media_ticket.issue(REL, CODE, 60, now=now)
    assert media_ticket.verify(REL, ticket, CODE, now=now + 59)
    assert not media_ticket.verify(REL, ticket, CODE, now=now + 61)


def test_ticket_dies_with_the_access_code():
    ticket = media_ticket.issue(REL, CODE, 600)
    assert not media_ticket.verify(REL, ticket, "rotated")


def test_junk_tickets_are_refused():
    for junk in ("", ".", "abc", "abc.def", f"{int(time.time()) + 600}.", "0.0"):
        assert not media_ticket.verify(REL, junk, CODE)


def test_gate_lets_a_ticketed_file_through(monkeypatch):
    sample = settings.data_dir / "voice-samples" / "v_gate.m4a"
    sample.parent.mkdir(parents=True, exist_ok=True)
    sample.write_bytes(b"sample")
    monkeypatch.setattr(settings, "access_code", CODE, raising=True)
    ticket = media_ticket.issue("voice-samples/v_gate.m4a", CODE, 600)
    with TestClient(app, base_url="https://testserver") as c:
        assert c.get("/media/voice-samples/v_gate.m4a").status_code == 401
        r = c.get(f"/media/voice-samples/v_gate.m4a?t={ticket}")
        assert r.status_code == 200 and r.content == b"sample"
        # A ticket for another file does not open this one.
        other = media_ticket.issue("voice-samples/v_else.m4a", CODE, 600)
        assert c.get(f"/media/voice-samples/v_gate.m4a?t={other}").status_code == 401


def test_ticket_cannot_reach_blocked_paths(monkeypatch):
    """The blocked-prefix check runs first, so no ticket can serve the db or tmp/."""
    (settings.data_dir / "tmp").mkdir(exist_ok=True)
    (settings.data_dir / "tmp" / "secret.wav").write_bytes(b"x")
    monkeypatch.setattr(settings, "access_code", CODE, raising=True)
    ticket = media_ticket.issue("tmp/secret.wav", CODE, 600)
    with TestClient(app, base_url="https://testserver") as c:
        assert c.get(f"/media/tmp/secret.wav?t={ticket}").status_code == 404
        db_ticket = media_ticket.issue("hitgo.db", CODE, 600)
        assert c.get(f"/media/hitgo.db?t={db_ticket}").status_code == 404
