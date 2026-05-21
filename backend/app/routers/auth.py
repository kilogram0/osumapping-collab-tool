"""Authentication router: osu! OAuth 2.0 and session management."""

import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import generate_oauth_state, get_current_user, validate_oauth_state
from app.models import User
from app.queries import MAX_DIFFICULTY_SLOTS_PER_OWNER, get_owner_quota_used
from app.schemas import QuotaRead, UserRead
from app.services.auth_service import (
    AuthServiceError,
    create_access_token,
    exchange_code_for_token,
    fetch_osu_user,
    upsert_user_by_osu_id,
)

router = APIRouter(prefix="/auth", tags=["auth"])

# Cookie settings shared by both state and session cookies
_COOKIE_PATH = "/"
_COOKIE_SAMESITE = settings.cookie_samesite


def _set_cookie(
    response: Response,
    name: str,
    value: str,
    max_age: int,
    secure: bool,
) -> None:
    """Set an HttpOnly cookie with standard security flags."""
    response.set_cookie(
        key=name,
        value=value,
        max_age=max_age,
        path=_COOKIE_PATH,
        httponly=True,
        samesite=_COOKIE_SAMESITE,
        secure=secure,
    )


def _clear_cookie(response: Response, name: str, secure: bool) -> None:
    """Expire a cookie immediately."""
    response.set_cookie(
        key=name,
        value="",
        max_age=0,
        path=_COOKIE_PATH,
        httponly=True,
        samesite=_COOKIE_SAMESITE,
        secure=secure,
    )


# ------------------------------------------------------------------
# OAuth init
# ------------------------------------------------------------------


@router.get("/osu/authorize")
async def osu_authorize() -> RedirectResponse:
    """Initiate the osu! OAuth 2.0 flow.

    Generates a signed state token, stores it in a short-lived HttpOnly
    cookie, and redirects the browser to the osu! authorization endpoint.
    """
    state = generate_oauth_state()

    redirect_url = (
        "https://osu.ppy.sh/oauth/authorize"
        f"?client_id={settings.OSU_CLIENT_ID}"
        f"&redirect_uri={settings.BACKEND_URL}/api/auth/osu/callback"
        f"&response_type=code"
        f"&scope=identify"
        f"&state={state}"
    )
    resp = RedirectResponse(redirect_url, status_code=302)
    _set_cookie(
        response=resp,
        name=settings.oauth_state_cookie_name,
        value=state,
        max_age=600,  # 10 minutes
        secure=settings.cookie_secure,
    )
    return resp


# ------------------------------------------------------------------
# OAuth callback
# ------------------------------------------------------------------


@router.get("/osu/callback")
async def osu_callback(
    request: Request,
    code: str,
    state: str,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> RedirectResponse:
    """Handle the osu! OAuth callback.

    Verifies the state parameter against the cookie, exchanges the
    authorization code for an access token, fetches the user's profile,
    upserts the local ``User`` row, creates a JWT session, and redirects
    to the frontend dashboard.
    """
    # 1. Verify state against cookie (CSRF defense)
    expected_state = request.cookies.get(settings.oauth_state_cookie_name)
    if expected_state is None:
        raise HTTPException(status_code=400, detail="Missing OAuth state cookie")

    if not secrets.compare_digest(state, expected_state):
        raise HTTPException(status_code=400, detail="Invalid OAuth state")

    # Validate signature / TTL *before* clearing so a retry is possible
    # if the HMAC check fails (e.g. clock skew).
    if not validate_oauth_state(state):
        raise HTTPException(status_code=400, detail="Expired or tampered OAuth state")

    # Clear the state cookie now that all validations passed
    redirect_url = f"{settings.FRONTEND_URL}/dashboard"
    resp = RedirectResponse(redirect_url, status_code=302)
    _clear_cookie(
        response=resp,
        name=settings.oauth_state_cookie_name,
        secure=settings.cookie_secure,
    )

    # 2. Exchange code for token
    redirect_uri = f"{settings.BACKEND_URL}/api/auth/osu/callback"
    try:
        access_token = await exchange_code_for_token(code, redirect_uri)
    except AuthServiceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    # 3. Fetch user info
    try:
        osu_payload = await fetch_osu_user(access_token)
    except AuthServiceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    # 4. Upsert local user
    try:
        user = await upsert_user_by_osu_id(db, osu_payload)
    except AuthServiceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Failed to persist user: {exc}"
        ) from exc

    # 5. Create JWT and set session cookie
    jwt_token = create_access_token(user.id)
    _set_cookie(
        response=resp,
        name=settings.cookie_name,
        value=jwt_token,
        max_age=settings.ACCESS_TOKEN_TTL_DAYS * 86400,
        secure=settings.cookie_secure,
    )

    return resp


# ------------------------------------------------------------------
# Session management
# ------------------------------------------------------------------


@router.get("/me", response_model=UserRead)
async def auth_me(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    """Return the currently authenticated user."""
    return current_user


@router.get("/me/quota", response_model=QuotaRead)
async def auth_me_quota(
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> QuotaRead:
    """Return the current user's difficulty slot usage."""
    used = await get_owner_quota_used(db, current_user.id)
    return QuotaRead(used=used, limit=MAX_DIFFICULTY_SLOTS_PER_OWNER)


@router.post("/logout")
async def auth_logout(response: Response) -> dict:
    """Clear the session cookie."""
    _clear_cookie(
        response=response,
        name=settings.cookie_name,
        secure=settings.cookie_secure,
    )
    return {"detail": "Logged out"}
