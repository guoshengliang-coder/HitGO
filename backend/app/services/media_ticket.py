"""Short-lived read tickets for one file under ``/media`` (contract §0, HIG-58).

``/media`` is behind the access-code gate, but Alibaba's voice-cloning endpoint has to
fetch the sample itself, anonymously, from the public internet. Rather than opening a
hole in the gate, the worker signs a ticket for the one path it wants read and appends
it as ``?t=<ticket>``; ``AccessGate`` lets that single path through until it expires.

Ticket format: ``<expires unix seconds>.<hex HMAC-SHA256 of "expires:path">``. Unlike
``upload_ticket`` the path is part of the signature, so a leaked ticket cannot be moved
to another file. The key is derived from ``ACCESS_CODE``, so rotating the code also
invalidates outstanding tickets.
"""

from __future__ import annotations

import hashlib
import hmac
import time

PARAM = "t"


def _key(access_code: str) -> bytes:
    return hashlib.sha256(f"hitgo-media-ticket:{access_code}".encode()).digest()


def _sign(expires: int, rel_path: str, access_code: str) -> str:
    return hmac.new(_key(access_code), f"{expires}:{rel_path}".encode(), hashlib.sha256).hexdigest()


def issue(rel_path: str, access_code: str, ttl: int, now: float | None = None) -> str:
    """Ticket for ``rel_path`` (the part of the URL after ``/media/``), valid for ``ttl`` seconds."""
    expires = int(now if now is not None else time.time()) + ttl
    return f"{expires}.{_sign(expires, rel_path, access_code)}"


def verify(rel_path: str, ticket: str, access_code: str, now: float | None = None) -> bool:
    expires_raw, sep, signature = ticket.strip().partition(".")
    if not sep or not expires_raw.isdigit():
        return False
    expires = int(expires_raw)
    if expires < (now if now is not None else time.time()):
        return False
    return hmac.compare_digest(signature, _sign(expires, rel_path, access_code))
