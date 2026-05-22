"""osu! OAuth 2.0 flow and JWT session management.

This module contains pure business logic: it knows nothing about FastAPI
request/response objects.  Router handlers in :mod:`app.routers.auth` are
responsible for HTTP concerns (cookies, redirects, status codes).
"""

import asyncio
from datetime import datetime, timedelta, timezone
from uuid import UUID

import httpx
import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import User

# ------------------------------------------------------------------
# osu! API endpoints
# ------------------------------------------------------------------
OSU_AUTHORIZE_URL = "https://osu.ppy.sh/oauth/authorize"
OSU_TOKEN_URL = "https://osu.ppy.sh/oauth/token"
OSU_API_ME_URL = "https://osu.ppy.sh/api/v2/me"
OSU_API_USERS_URL = "https://osu.ppy.sh/api/v2/users"

# ------------------------------------------------------------------
# Client credentials token cache
# ------------------------------------------------------------------
_cc_lock = asyncio.Lock()
_cc_token: str | None = None
_cc_token_expires_at: datetime | None = None

# ------------------------------------------------------------------
# Token exchange
# ------------------------------------------------------------------


async def exchange_code_for_token(code: str, redirect_uri: str) -> str:
    """Trade an OAuth authorization ``code`` for an osu! access token.

    Returns the access-token string on success.  Raises
    :class:`AuthServiceError` on any HTTP or JSON error.
    """
    payload = {
        "client_id": settings.OSU_CLIENT_ID,
        "client_secret": settings.OSU_CLIENT_SECRET,
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            response = await client.post(OSU_TOKEN_URL, data=payload)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise AuthServiceError(
                f"osu! token endpoint returned {exc.response.status_code}"
            ) from exc
        except httpx.RequestError as exc:
            raise AuthServiceError(f"Failed to contact osu! token endpoint: {exc}") from exc

    data = response.json()
    access_token = data.get("access_token")
    if not access_token:
        raise AuthServiceError("osu! token response missing 'access_token'")

    return access_token


# ------------------------------------------------------------------
# User info
# ------------------------------------------------------------------


async def fetch_osu_user(access_token: str) -> dict:
    """Fetch the authenticated user's profile from ``/api/v2/me``.

    Returns the raw JSON payload.  Raises :class:`AuthServiceError` on failure.
    """
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            response = await client.get(OSU_API_ME_URL, headers=headers)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise AuthServiceError(
                f"osu! /api/v2/me returned {exc.response.status_code}"
            ) from exc
        except httpx.RequestError as exc:
            raise AuthServiceError(f"Failed to contact osu! API: {exc}") from exc

    return response.json()


# ------------------------------------------------------------------
# Client credentials (server-to-server) token
# ------------------------------------------------------------------


async def _fetch_client_credentials_token() -> str:
    """Return a cached client credentials access token, refreshing when near expiry."""
    global _cc_token, _cc_token_expires_at
    async with _cc_lock:
        now = datetime.now(timezone.utc)
        if _cc_token and _cc_token_expires_at and now < _cc_token_expires_at:
            return _cc_token

        payload = {
            "client_id": settings.OSU_CLIENT_ID,
            "client_secret": settings.OSU_CLIENT_SECRET,
            "grant_type": "client_credentials",
            "scope": "public",
        }
        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                response = await client.post(OSU_TOKEN_URL, data=payload)
                response.raise_for_status()
                data = response.json()
            except httpx.HTTPStatusError as exc:
                raise AuthServiceError(
                    f"osu! token endpoint returned {exc.response.status_code}"
                ) from exc
            except httpx.RequestError as exc:
                raise AuthServiceError(
                    f"Failed to contact osu! token endpoint: {exc}"
                ) from exc

        token = data.get("access_token")
        if not token:
            raise AuthServiceError("osu! token response missing 'access_token'")

        expires_in = int(data.get("expires_in", 86400))
        _cc_token = token
        # Refresh 5 minutes before expiry to avoid using a stale token
        _cc_token_expires_at = now + timedelta(seconds=expires_in - 300)
        return _cc_token


async def lookup_osu_user_by_username(username: str) -> dict | None:
    """Look up any osu! user by username via the public API.

    Uses client credentials so no user session is required.
    Returns the raw profile payload, or ``None`` if the username does not exist.
    Raises :class:`AuthServiceError` on unexpected API failures.
    """
    token = await _fetch_client_credentials_token()
    headers = {"Authorization": f"Bearer {token}"}
    url = f"{OSU_API_USERS_URL}/{username}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            response = await client.get(url, headers=headers, params={"key": "username"})
            if response.status_code == 404:
                return None
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as exc:
            raise AuthServiceError(
                f"osu! /api/v2/users returned {exc.response.status_code}"
            ) from exc
        except httpx.RequestError as exc:
            raise AuthServiceError(f"Failed to contact osu! API: {exc}") from exc


# ------------------------------------------------------------------
# Database upsert
# ------------------------------------------------------------------


async def upsert_user_by_osu_id(session: AsyncSession, osu_payload: dict) -> User:
    """Look up a ``User`` by ``osu_id``; create or refresh display fields.

    The ``osu_id`` is the stable identifier.  ``username`` and ``avatar_url``
    are refreshed from the API payload on every login.

    Uses ``INSERT ... ON CONFLICT DO UPDATE`` to eliminate the read-then-write
    race when two concurrent first-time logins share the same ``osu_id``.
    """
    from sqlalchemy.dialects.postgresql import insert

    osu_id = osu_payload.get("id")
    username = osu_payload.get("username")
    avatar_url = osu_payload.get("avatar_url", "")

    if osu_id is None or username is None:
        raise AuthServiceError("osu! /api/v2/me response missing required fields")

    stmt = (
        insert(User)
        .values(osu_id=osu_id, username=username, avatar_url=avatar_url)
        .on_conflict_do_update(
            index_elements=[User.osu_id],
            set_=dict(username=username, avatar_url=avatar_url),
        )
        .returning(User)
    )
    result = await session.execute(stmt)
    user = result.scalar_one()
    await session.commit()
    return user


# ------------------------------------------------------------------
# JWT
# ------------------------------------------------------------------


def create_access_token(user_id: UUID) -> str:
    """Encode a JWT containing ``sub`` (internal user id) and ``exp``.

    The TTL is controlled by :attr:`settings.ACCESS_TOKEN_TTL_DAYS`.
    """
    now = datetime.now(timezone.utc)
    exp = now + timedelta(days=settings.ACCESS_TOKEN_TTL_DAYS)
    payload = {"sub": str(user_id), "exp": exp, "iat": now}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm="HS256")


def decode_access_token(token: str) -> dict:
    """Decode and validate a JWT access token.

    Returns the payload dict on success.  Raises :class:`AuthServiceError`
    if the token is expired, malformed, or has an invalid signature.
    """
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
    except jwt.ExpiredSignatureError as exc:
        raise AuthServiceError("Token has expired") from exc
    except jwt.InvalidTokenError as exc:
        raise AuthServiceError("Invalid token") from exc


# ------------------------------------------------------------------
# Exceptions
# ------------------------------------------------------------------


class AuthServiceError(Exception):
    """Raised when an auth-service operation fails."""
