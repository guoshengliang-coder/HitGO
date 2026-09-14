"""Access-code auth (contract §0): GET/POST /api/auth, cookie hitgo_access."""

from __future__ import annotations

import secrets

from fastapi import APIRouter, HTTPException, Request, Response

from app.config import settings
from app.schemas import AuthIn, AuthOut

router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE_NAME = "hitgo_access"
COOKIE_MAX_AGE = 30 * 24 * 3600


def access_ok(request: Request) -> bool:
    if not settings.access_code:
        return True
    cookie = request.cookies.get(COOKIE_NAME, "")
    return secrets.compare_digest(cookie, settings.access_code)


@router.get("", response_model=AuthOut)
def auth_status(request: Request) -> AuthOut:
    return AuthOut(required=bool(settings.access_code), ok=access_ok(request))


@router.post("", response_model=AuthOut)
def auth_login(body: AuthIn, response: Response) -> AuthOut:
    if not settings.access_code:
        return AuthOut(required=False, ok=True)
    if not secrets.compare_digest(body.code.strip(), settings.access_code):
        raise HTTPException(401, "访问码不正确")
    response.set_cookie(
        COOKIE_NAME,
        settings.access_code,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=settings.public_base_url.startswith("https://"),
        path="/",
    )
    return AuthOut(required=True, ok=True)
