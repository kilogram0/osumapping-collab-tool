"""Integration tests for osu! OAuth flow and session management."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import app.services.auth_service as _auth_svc
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
    assert data["id"] == str(user.id)
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
    token = create_access_token(uuid4())
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
        "sub": str(uuid4()),
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


# ---------------------------------------------------------------------------
# GET /auth/me/storage
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_me_storage_returns_zero_for_new_user(client: AsyncClient):
    """A user with no mapsets has used_bytes == 0."""
    from app.queries import PENDING_STORAGE_LIMIT_BYTES, STORAGE_LIMIT_BYTES

    user = await _seed_user(91001, "StorageUser", "https://a.ppy.sh/91001")
    client.cookies.set(settings.cookie_name, create_access_token(user.id))

    resp = await client.get("/api/auth/me/storage")
    assert resp.status_code == 200
    body = resp.json()
    assert body["used_bytes"] == 0
    assert body["pending_bytes"] == 0
    assert body["limit_bytes"] == STORAGE_LIMIT_BYTES
    assert body["pending_limit_bytes"] == PENDING_STORAGE_LIMIT_BYTES

    # Cleanup
    from sqlalchemy import delete
    from sqlalchemy.ext.asyncio import async_sessionmaker
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        await session.execute(delete(User).where(User.id == user.id))
        await session.commit()


@pytest.mark.asyncio
async def test_me_storage_counts_empty_mapset_as_floor(client: AsyncClient):
    """An empty owned mapset consumes the per-mapset storage floor."""
    from app.models import Mapset
    from app.queries import MAPSET_STORAGE_FLOOR_BYTES

    user = await _seed_user(91002, "StorageUser2", "https://a.ppy.sh/91002")
    client.cookies.set(settings.cookie_name, create_access_token(user.id))

    CSRF_HEADERS = {"X-Requested-With": "XMLHttpRequest", "Origin": settings.FRONTEND_URL}
    mapset_payload = {
        "id": str(uuid4()),
        "title": "Storage Test",
        "encrypted_song_length_ms": "encrypted:1000",
        "passphrase_salt": "c2FsdC1iYXNlNjQ=",
        "encrypted_verification": "encrypted:verified",
    }
    r = await client.post("/api/mapsets", json=mapset_payload, headers=CSRF_HEADERS)
    assert r.status_code == 201

    resp = await client.get("/api/auth/me/storage")
    assert resp.status_code == 200
    body = resp.json()
    assert body["used_bytes"] == MAPSET_STORAGE_FLOOR_BYTES

    # Cleanup
    from sqlalchemy import delete
    from sqlalchemy.ext.asyncio import async_sessionmaker
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        await session.execute(delete(Mapset).where(Mapset.owner_id == user.id))
        await session.execute(delete(User).where(User.id == user.id))
        await session.commit()


@pytest.mark.asyncio
async def test_me_storage_rejects_unauthenticated(client: AsyncClient):
    resp = await client.get("/api/auth/me/storage")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Helpers shared by CC-token and lookup tests
# ---------------------------------------------------------------------------


@pytest.fixture
def reset_cc_cache():
    """Wipe the module-level client-credentials token cache around a test."""
    _auth_svc._cc_token = None
    _auth_svc._cc_token_expires_at = None
    yield
    _auth_svc._cc_token = None
    _auth_svc._cc_token_expires_at = None


def _httpx_cls_mock(
    status: int = 200,
    json_body: dict | None = None,
    raise_for_status_exc=None,
    post_side_effect=None,
    get_side_effect=None,
):
    """Return (cls_mock, inner_client_mock, response_mock) for patching httpx.AsyncClient."""
    response = MagicMock()
    response.status_code = status
    response.json.return_value = json_body or {}
    if raise_for_status_exc is not None:
        response.raise_for_status.side_effect = raise_for_status_exc

    inner = AsyncMock()
    if post_side_effect is not None:
        inner.post.side_effect = post_side_effect
    else:
        inner.post.return_value = response
    if get_side_effect is not None:
        inner.get.side_effect = get_side_effect
    else:
        inner.get.return_value = response

    cls = MagicMock()
    cls.return_value.__aenter__ = AsyncMock(return_value=inner)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return cls, inner, response


# ---------------------------------------------------------------------------
# _fetch_client_credentials_token
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_cc_token_fetches_and_caches(reset_cc_cache):
    """First call hits the token endpoint and caches the result."""
    cls, inner, _ = _httpx_cls_mock(
        200, {"access_token": "cc-tok-abc", "expires_in": 86400}
    )
    with patch("app.services.auth_service.httpx.AsyncClient", cls):
        token = await _auth_svc._fetch_client_credentials_token()

    assert token == "cc-tok-abc"
    assert _auth_svc._cc_token == "cc-tok-abc"
    inner.post.assert_awaited_once()


@pytest.mark.asyncio
async def test_fetch_cc_token_reuses_cached_token(reset_cc_cache):
    """Subsequent calls return the cached token without any network request."""
    _auth_svc._cc_token = "cached-token"
    _auth_svc._cc_token_expires_at = datetime.now(timezone.utc) + timedelta(hours=12)

    cls, inner, _ = _httpx_cls_mock()
    with patch("app.services.auth_service.httpx.AsyncClient", cls):
        token = await _auth_svc._fetch_client_credentials_token()

    assert token == "cached-token"
    inner.post.assert_not_awaited()


@pytest.mark.asyncio
async def test_fetch_cc_token_refreshes_expired_token(reset_cc_cache):
    """An expired cached token is discarded and a fresh one is fetched."""
    _auth_svc._cc_token = "old-token"
    _auth_svc._cc_token_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)

    cls, inner, _ = _httpx_cls_mock(
        200, {"access_token": "new-token", "expires_in": 86400}
    )
    with patch("app.services.auth_service.httpx.AsyncClient", cls):
        token = await _auth_svc._fetch_client_credentials_token()

    assert token == "new-token"
    inner.post.assert_awaited_once()


@pytest.mark.asyncio
async def test_fetch_cc_token_raises_on_http_error(reset_cc_cache):
    """An HTTP error from the token endpoint raises AuthServiceError."""
    import httpx as _httpx

    exc = _httpx.HTTPStatusError(
        "400",
        request=_httpx.Request("POST", "https://osu.ppy.sh/oauth/token"),
        response=_httpx.Response(400),
    )
    cls, _, _ = _httpx_cls_mock(400, raise_for_status_exc=exc)
    with patch("app.services.auth_service.httpx.AsyncClient", cls):
        with pytest.raises(AuthServiceError, match="400"):
            await _auth_svc._fetch_client_credentials_token()


@pytest.mark.asyncio
async def test_fetch_cc_token_raises_on_network_error(reset_cc_cache):
    """A network error contacting the token endpoint raises AuthServiceError."""
    import httpx as _httpx

    cls, _, _ = _httpx_cls_mock(post_side_effect=_httpx.ConnectError("refused"))
    with patch("app.services.auth_service.httpx.AsyncClient", cls):
        with pytest.raises(AuthServiceError, match="refused"):
            await _auth_svc._fetch_client_credentials_token()


@pytest.mark.asyncio
async def test_fetch_cc_token_raises_when_access_token_missing(reset_cc_cache):
    """A response missing access_token raises AuthServiceError."""
    cls, _, _ = _httpx_cls_mock(200, {"token_type": "Bearer"})
    with patch("app.services.auth_service.httpx.AsyncClient", cls):
        with pytest.raises(AuthServiceError, match="missing 'access_token'"):
            await _auth_svc._fetch_client_credentials_token()


# ---------------------------------------------------------------------------
# lookup_osu_user_by_username
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lookup_osu_user_returns_payload():
    """A 200 response returns the user profile dict."""
    payload = {"id": 12345, "username": "SomeUser", "avatar_url": "https://a.ppy.sh/12345"}
    cls, inner, _ = _httpx_cls_mock(200, payload)
    with (
        patch(
            "app.services.auth_service._fetch_client_credentials_token",
            new_callable=AsyncMock,
            return_value="fake-token",
        ),
        patch("app.services.auth_service.httpx.AsyncClient", cls),
    ):
        result = await _auth_svc.lookup_osu_user_by_username("SomeUser")

    assert result == payload
    call_args = inner.get.call_args
    assert "SomeUser" in call_args.args[0]
    assert call_args.kwargs.get("params") == {"key": "username"}
    assert call_args.kwargs["headers"]["Authorization"] == "Bearer fake-token"


@pytest.mark.asyncio
async def test_lookup_osu_user_returns_none_on_404():
    """A 404 response returns None without raising."""
    cls, _, _ = _httpx_cls_mock(404)
    with (
        patch(
            "app.services.auth_service._fetch_client_credentials_token",
            new_callable=AsyncMock,
            return_value="fake-token",
        ),
        patch("app.services.auth_service.httpx.AsyncClient", cls),
    ):
        result = await _auth_svc.lookup_osu_user_by_username("nobody")

    assert result is None


@pytest.mark.asyncio
async def test_lookup_osu_user_raises_on_http_error():
    """A non-404 HTTP error raises AuthServiceError."""
    import httpx as _httpx

    exc = _httpx.HTTPStatusError(
        "503",
        request=_httpx.Request("GET", "https://osu.ppy.sh/api/v2/users/test"),
        response=_httpx.Response(503),
    )
    cls, _, _ = _httpx_cls_mock(503, raise_for_status_exc=exc)
    with (
        patch(
            "app.services.auth_service._fetch_client_credentials_token",
            new_callable=AsyncMock,
            return_value="fake-token",
        ),
        patch("app.services.auth_service.httpx.AsyncClient", cls),
    ):
        with pytest.raises(AuthServiceError, match="503"):
            await _auth_svc.lookup_osu_user_by_username("test")


@pytest.mark.asyncio
async def test_lookup_osu_user_raises_on_network_error():
    """A network-level failure raises AuthServiceError."""
    import httpx as _httpx

    cls, _, _ = _httpx_cls_mock(get_side_effect=_httpx.ConnectError("refused"))
    with (
        patch(
            "app.services.auth_service._fetch_client_credentials_token",
            new_callable=AsyncMock,
            return_value="fake-token",
        ),
        patch("app.services.auth_service.httpx.AsyncClient", cls),
    ):
        with pytest.raises(AuthServiceError, match="refused"):
            await _auth_svc.lookup_osu_user_by_username("test")

