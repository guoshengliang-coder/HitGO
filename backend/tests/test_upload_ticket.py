"""Upload tickets for the CDN-bypassing upload host (contract §3 素材)."""

from app.services import upload_ticket


def test_ticket_roundtrip_and_expiry():
    ticket, expires = upload_ticket.issue("secret", now=1000)
    assert expires == 1000 + upload_ticket.TICKET_TTL_SECONDS
    assert upload_ticket.verify(ticket, "secret", now=1000)
    assert upload_ticket.verify(ticket, "secret", now=expires)
    assert not upload_ticket.verify(ticket, "secret", now=expires + 1)


def test_ticket_is_bound_to_the_access_code_and_cannot_be_tampered_with():
    ticket, expires = upload_ticket.issue("secret", now=1000)
    assert not upload_ticket.verify(ticket, "other", now=1000)
    signature = ticket.split(".", 1)[1]
    assert not upload_ticket.verify(f"{expires + 9999}.{signature}", "secret", now=1000)  # extended
    for junk in ("", "nope", ".abc", "12.", "x.y", f"{expires}"):
        assert not upload_ticket.verify(junk, "secret", now=1000)
