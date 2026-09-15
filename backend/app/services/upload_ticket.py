"""Short-lived upload tickets for the CDN-bypassing upload host (contract §3 素材).

The main hostname sits behind Cloudflare, which rejects request bodies over 100 MB
on the free plan. Large asset uploads therefore go to a second, DNS-only hostname.
The access cookie is host-only and must stay that way (its value *is* the access
code), so the upload host cannot see it; instead the main host signs a ticket the
browser sends along as ``X-Upload-Ticket``.

Ticket format: ``<expires unix seconds>.<hex HMAC-SHA256>``. The key is derived from
``ACCESS_CODE``, so rotating the code also invalidates outstanding tickets.
"""

from __future__ import annotations

import hashlib
import hmac
import time

TICKET_TTL_SECONDS = 600
HEADER = "x-upload-ticket"


def _key(access_code: str) -> bytes:
    return hashlib.sha256(f"hitgo-upload-ticket:{access_code}".encode()).digest()


def _sign(expires: int, access_code: str) -> str:
    return hmac.new(_key(access_code), str(expires).encode(), hashlib.sha256).hexdigest()


def issue(access_code: str, now: float | None = None, ttl: int = TICKET_TTL_SECONDS) -> tuple[str, int]:
    """(ticket, expires unix seconds)."""
    expires = int(now if now is not None else time.time()) + ttl
    return f"{expires}.{_sign(expires, access_code)}", expires


def verify(ticket: str, access_code: str, now: float | None = None) -> bool:
    expires_raw, sep, signature = ticket.strip().partition(".")
    if not sep or not expires_raw.isdigit():
        return False
    expires = int(expires_raw)
    if expires < (now if now is not None else time.time()):
        return False
    return hmac.compare_digest(signature, _sign(expires, access_code))
