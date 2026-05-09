"""Integration tests for osu! OAuth flow and session management."""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import generate_oauth_state
from app.models import User
from app.services.auth_service import AuthServiceError, create_access_token
from tests.conftest import test_engine


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _extract_cookie_value(response, cookie_name: str) -> str | None:
    """Parse a Set-Cookie header and return the cookie value."""
    set_cookie = response.headers.get("set-cookie")
    if not set_cookie:
        return None
    # httpx merges multiple Set-Cookie headers with commas; split carefully
    # Each cookie is "name=value; ..."
    for part in set_cookie.split(","):
        part = part.strip()
        if part.startswith(f"{cookie_name}="):
            raw = part.split(";", 1)[0].split("=", 1)[1]
            # Strip surrounding quotes if present
            if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
                return raw[1:-1]
            return raw
    return None


def _make_osu_me_payload(osu_id: int, username: str, avatar_url: str) -> dict:
    return {
        "id": osu_id,
        "username": username,
        "avatar_url": avatar_url,
    }


async def _seed_user(osu_id: int, username: str, avatar_url: str) -> User:
    """Insert a User row via a standalone session that fully commits.

    Use this in integration tests that also use the ``client`` fixture,
    because ``db_session`` holds an uncommitted outer transaction that
    hides its changes from other connections.

    Any existing user with the same ``osu_id`` is deleted first so that
    tests are idempotent across reruns.
    """
    from sqlalchemy import delete
    from sqlalchemy.ext.asyncio import async_sessionmaker

    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        await session.execute(delete(User).where(User.osu_id == osu_id))
        await session.commit()
        user = User(osu_id=osu_id, username=username, avatar_url=avatar_url)
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


# ------------------------------------------------------------------
# /auth/osu/authorize
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_authorize_redirects_to_osu_with_state_cookie(client: AsyncClient):
    """Initiating OAuth sets a state cookie and 302-redirects to osu!."""
    response = await client.get("/api/auth/osu/authorize", follow_redirects=False)

    assert response.status_code == 302
    location = response.headers["location"]
    assert location.startswith("https://osu.ppy.sh/oauth/authorize")
    assert f"client_id={settings.OSU_CLIENT_ID}" in location
    assert "scope=identify" in location
    assert "state=" in location

    cookie_name = settings.oauth_state_cookie_name
    cookie_value = _extract_cookie_value(response, cookie_name)
    assert cookie_value is not None
    assert cookie_value in location  # state in URL matches cookie


# ------------------------------------------------------------------
# /auth/osu/callback — happy path
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_callback_creates_user_and_sets_session_cookie(client: AsyncClient, db_session):
    """A successful callback upserts a new User and sets the access_token cookie."""
    state = generate_oauth_state()
    cookie_name = settings.oauth_state_cookie_name

    client.cookies.set(cookie_name, state)

    with (
        patch(
            "app.routers.auth.exchange_code_for_token",
            new=AsyncMock(return_value="fake_access_token"),
        ) as mock_exchange,
        patch(
            "app.routers.auth.fetch_osu_user",
            new=AsyncMock(
                return_value=_make_osu_me_payload(99999, "NewMapper", "https://a.ppy.sh/99999")
            ),
        ) as mock_fetch,
    ):
        response = await client.get(
            "/api/auth/osu/callback",
            params={"code": "auth_code_123", "state": state},
            follow_redirects=False,
        )

    mock_exchange.assert_awaited_once_with("auth_code_123", f"{settings.BACKEND_URL}/api/auth/osu/callback")
    mock_fetch.assert_awaited_once_with("fake_access_token")

    assert response.status_code == 302
    assert response.headers["location"] == f"{settings.FRONTEND_URL}/dashboard"

    # Session cookie is set
    jwt_cookie = _extract_cookie_value(response, settings.cookie_name)
    assert jwt_cookie is not None
    assert jwt_cookie != ""

    # State cookie is cleared
    state_cookie = _extract_cookie_value(response, cookie_name)
    assert state_cookie == ""

    # User was created in the database
    from sqlalchemy import select
    result = await db_session.execute(select(User).where(User.osu_id == 99999))
    user = result.scalar_one()
    assert user.username == "NewMapper"
    assert user.avatar_url == "https://a.ppy.sh/99999"


@pytest.mark.asyncio
async def test_callback_refreshes_existing_user(client: AsyncClient):
    """Logging in again updates username and avatar for an existing user."""
    state = generate_oauth_state()
    cookie_name = settings.oauth_state_cookie_name

    # Seed an existing user via a committed session so the client can see it
    await _seed_user(88888, "OldName", "https://a.ppy.sh/old")

    client.cookies.set(cookie_name, state)

    with (
        patch(
            "app.routers.auth.exchange_code_for_token",
            new=AsyncMock(return_value="tok"),
        ),
        patch(
            "app.routers.auth.fetch_osu_user",
            new=AsyncMock(
                return_value=_make_osu_me_payload(88888, "NewName", "https://a.ppy.sh/new")
            ),
        ),
    ):
        response = await client.get(
            "/api/auth/osu/callback",
            params={"code": "c", "state": state},
            follow_redirects=False,
        )

    assert response.status_code == 302

    # Verify the user was updated by calling /auth/me.
    # The client cookie jar already holds the access_token from the Set-Cookie header.
    jwt_cookie = _extract_cookie_value(response, settings.cookie_name)
    assert jwt_cookie is not None
    me_resp = await client.get("/api/auth/me")
    assert me_resp.status_code == 200
    data = me_resp.json()
    assert data["osu_id"] == 88888
    assert data["username"] == "NewName"
    assert data["avatar_url"] == "https://a.ppy.sh/new"


# ------------------------------------------------------------------
# /auth/osu/callback — error cases
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_callback_rejects_missing_state_cookie(client: AsyncClient):
    """Callback without the state cookie must return 400."""
    response = await client.get(
        "/api/auth/osu/callback",
        params={"code": "x", "state": generate_oauth_state()},
        follow_redirects=False,
    )
    assert response.status_code == 400
    assert "Missing OAuth state cookie" in response.text


@pytest.mark.asyncio
async def test_callback_rejects_mismatched_state(client: AsyncClient):
    """Callback with a state that does not match the cookie must return 400."""
    state_a = generate_oauth_state()
    state_b = generate_oauth_state()
    cookie_name = settings.oauth_state_cookie_name

    client.cookies.set(cookie_name, state_b)
    response = await client.get(
        "/api/auth/osu/callback",
        params={"code": "x", "state": state_a},
        follow_redirects=False,
    )
    assert response.status_code == 400
    assert "Invalid OAuth state" in response.text


@pytest.mark.asyncio
async def test_callback_rejects_expired_state(client: AsyncClient):
    """A state whose HMAC TTL has expired must return 400."""
    import time
    from unittest.mock import patch as _patch

    # Generate a state 20 minutes in the past
    with _patch("time.time", return_value=time.time() - 1200):
        old_state = generate_oauth_state()

    cookie_name = settings.oauth_state_cookie_name
    client.cookies.set(cookie_name, old_state)
    response = await client.get(
        "/api/auth/osu/callback",
        params={"code": "x", "state": old_state},
        follow_redirects=False,
    )
    assert response.status_code == 400
    assert "Expired or tampered OAuth state" in response.text


# ------------------------------------------------------------------
# /auth/me
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_me_returns_authenticated_user(client: AsyncClient):
    """GET /auth/me must return the current user when a valid JWT cookie is present."""
    user = await _seed_user(55555, "MeUser", "https://a.ppy.sh/55555")

    token = create_access_token(user.id)
    client.cookies.set(settings.cookie_name, token)
    response = await client.get("/api/auth/me")

    assert response.status_code == 200
    data = response.json()
    assert data["id"] == user.id
    assert data["osu_id"] == 55555
    assert data["username"] == "MeUser"
    assert data["avatar_url"] == "https://a.ppy.sh/55555"


@pytest.mark.asyncio
async def test_me_rejects_unauthenticated(client: AsyncClient):
    """GET /auth/me without a session cookie must return 401."""
    response = await client.get("/api/auth/me")
    assert response.status_code == 401
    assert "Not authenticated" in response.json()["detail"]


@pytest.mark.asyncio
async def test_me_rejects_invalid_token(client: AsyncClient):
    """GET /auth/me with a malformed JWT must return 401."""
    client.cookies.set(settings.cookie_name, "not-a-jwt")
    response = await client.get("/api/auth/me")
    assert response.status_code == 401


# ------------------------------------------------------------------
# /auth/logout
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_logout_clears_session_cookie(client: AsyncClient):
    """POST /auth/logout must expire the access_token cookie."""
    token = create_access_token(1)
    client.cookies.set(settings.cookie_name, token)
    response = await client.post("/api/auth/logout")

    assert response.status_code == 200
    assert response.json()["detail"] == "Logged out"

    cleared = _extract_cookie_value(response, settings.cookie_name)
    assert cleared == ""


# ------------------------------------------------------------------
# Additional coverage gaps
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_callback_returns_502_when_token_endpoint_fails(client: AsyncClient):
    """If osu! token endpoint returns 4xx/5xx, callback must return 502."""
    state = generate_oauth_state()
    cookie_name = settings.oauth_state_cookie_name
    client.cookies.set(cookie_name, state)

    with patch(
        "app.routers.auth.exchange_code_for_token",
        new=AsyncMock(
            side_effect=AuthServiceError("osu! token endpoint returned 400")
        ),
    ):
        response = await client.get(
            "/api/auth/osu/callback",
            params={"code": "bad_code", "state": state},
            follow_redirects=False,
        )

    assert response.status_code == 502
    assert "token endpoint returned 400" in response.json()["detail"]


@pytest.mark.asyncio
async def test_callback_returns_502_when_osu_me_missing_fields(client: AsyncClient):
    """If osu! /api/v2/me response lacks required fields, callback must 502."""
    state = generate_oauth_state()
    cookie_name = settings.oauth_state_cookie_name
    client.cookies.set(cookie_name, state)

    with (
        patch(
            "app.routers.auth.exchange_code_for_token",
            new=AsyncMock(return_value="tok"),
        ),
        patch(
            "app.routers.auth.fetch_osu_user",
            new=AsyncMock(return_value={"id": 12345}),  # missing username
        ),
    ):
        response = await client.get(
            "/api/auth/osu/callback",
            params={"code": "c", "state": state},
            follow_redirects=False,
        )

    assert response.status_code == 502
    assert "missing required fields" in response.json()["detail"]


@pytest.mark.asyncio
async def test_me_rejects_expired_token(client: AsyncClient):
    """GET /auth/me with an expired JWT must return 401."""
    import jwt
    from app.config import settings as _settings
    from datetime import datetime, timedelta, timezone

    expired_payload = {
        "sub": "1",
        "exp": datetime.now(timezone.utc) - timedelta(seconds=1),
        "iat": datetime.now(timezone.utc) - timedelta(days=1),
    }
    expired_token = jwt.encode(
        expired_payload, _settings.SECRET_KEY, algorithm="HS256"
    )
    client.cookies.set(settings.cookie_name, expired_token)
    response = await client.get("/api/auth/me")
    assert response.status_code == 401
    assert "expired" in response.json()["detail"].lower()
