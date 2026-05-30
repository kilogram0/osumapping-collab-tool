"""E2EE automated integration test (Phase 7.6).

Verifies two properties of every API response:

(a) No bare plaintext content field name appears in the JSON body.
    Fields that must always use the `encrypted_` prefix:
      description, song_length_ms, name, content, body,
      start_time_ms, end_time_ms, sort_order.
    Note: `title` is intentionally plaintext in Mapset by design
    (see migration 4c62ef0c9732_make_mapset_title_plaintext).

(b) Every `encrypted_*` value is base64-decodable and decodes to at
    least 28 bytes (12-byte AES-GCM IV + 16-byte GCM tag minimum).
    This catches the bug where a developer stores plaintext inside an
    `encrypted_*` wrapper.
"""

import base64
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.models import Mapset, User
from app.services.auth_service import create_access_token
from tests.conftest import test_engine

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CSRF_HEADERS = {
    "X-Requested-With": "XMLHttpRequest",
    "Origin": settings.FRONTEND_URL,
}

# 32 random bytes base64-encoded (44 chars). Decodes to 32 bytes > 28 minimum.
_FAKE_ENC = base64.b64encode(b"\xab\xcd\xef" * 10 + b"\x01\x02").decode()

# Plaintext field names that must NEVER appear bare in JSON payloads.
#
# Caveat: "name" is generic. Currently no API response contains a bare
# `name` field (users use `username`, mapsets use `title`), but if a future
# endpoint exposes a legitimately plaintext `name` (e.g. a role label),
# either rename that field or scope this check per-endpoint.
FORBIDDEN_BARE_KEYS = {
    "description",
    "song_length_ms",
    "name",
    "content",
    "body",
    "start_time_ms",
    "end_time_ms",
    "sort_order",
    "url",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _assert_no_bare_content_keys(data: object, path: str = "") -> None:
    """Recursively assert that FORBIDDEN_BARE_KEYS do not appear as JSON keys."""
    if isinstance(data, dict):
        for key, value in data.items():
            loc = f"{path}.{key}" if path else key
            assert key not in FORBIDDEN_BARE_KEYS, (
                f"Bare plaintext field '{key}' found in response at '{loc}'. "
                f"It must be sent as 'encrypted_{key}'."
            )
            _assert_no_bare_content_keys(value, loc)
    elif isinstance(data, list):
        for i, item in enumerate(data):
            _assert_no_bare_content_keys(item, f"{path}[{i}]")


def _assert_encrypted_values_are_valid_base64(data: object, path: str = "") -> None:
    """Recursively assert that all encrypted_* values are valid base64 >= 28 bytes."""
    if isinstance(data, dict):
        for key, value in data.items():
            loc = f"{path}.{key}" if path else key
            if key.startswith("encrypted_") and isinstance(value, str):
                try:
                    decoded = base64.b64decode(value, validate=True)
                except Exception as exc:
                    raise AssertionError(
                        f"Field '{loc}' = {value!r} is not valid base64: {exc}"
                    ) from exc
                assert len(decoded) >= 28, (
                    f"Field '{loc}' decodes to only {len(decoded)} bytes "
                    f"(minimum 28 = 12-byte IV + 16-byte GCM tag). "
                    f"Value: {value!r}"
                )
            _assert_encrypted_values_are_valid_base64(value, loc)
    elif isinstance(data, list):
        for i, item in enumerate(data):
            _assert_encrypted_values_are_valid_base64(item, f"{path}[{i}]")


def _check(data: object) -> None:
    """Run both E2EE assertions on a decoded JSON response."""
    _assert_no_bare_content_keys(data)
    _assert_encrypted_values_are_valid_base64(data)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


async def _seed_user(osu_id: int) -> User:
    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        existing = (
            await session.execute(select(User.id).where(User.osu_id == osu_id))
        ).scalar_one_or_none()
        if existing is not None:
            await session.execute(delete(Mapset).where(Mapset.owner_id == existing))
            await session.execute(delete(User).where(User.id == existing))
            await session.commit()
        user = User(
            osu_id=osu_id,
            username=f"e2ee-user-{osu_id}",
            avatar_url=f"https://a.ppy.sh/{osu_id}",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


async def _cleanup_user(user_id) -> None:
    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        await session.execute(delete(Mapset).where(Mapset.owner_id == user_id))
        await session.execute(delete(User).where(User.id == user_id))
        await session.commit()


@pytest.fixture
async def e2ee_client(client: AsyncClient):
    user = await _seed_user(90001)
    client.cookies.set(settings.cookie_name, create_access_token(user.id))
    try:
        yield client, user
    finally:
        await _cleanup_user(user.id)


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_e2ee_no_plaintext_in_api_responses(e2ee_client):
    """
    Full E2EE smoke test: create a mapset → difficulty → section → post →
    osu version, then call every relevant GET endpoint and assert:
      (a) no bare content field names in JSON
      (b) all encrypted_* values are valid base64 >= 28 bytes
    """
    client, _ = e2ee_client

    # --- Create mapset ---
    mapset_id = str(uuid4())
    resp = await client.post(
        "/api/mapsets",
        json={
            "id": mapset_id,
            "title": "E2EE Test Mapset",
            "encrypted_description": _FAKE_ENC,
            "encrypted_song_length_ms": _FAKE_ENC,
            "passphrase_salt": base64.b64encode(b"s" * 16).decode(),
            "encrypted_verification": _FAKE_ENC,
        },
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    _check(resp.json())

    # GET /mapsets
    resp = await client.get("/api/mapsets")
    assert resp.status_code == 200
    _check(resp.json())

    # GET /mapsets/{id}
    resp = await client.get(f"/api/mapsets/{mapset_id}")
    assert resp.status_code == 200
    _check(resp.json())

    # --- Create difficulty ---
    difficulty_id = str(uuid4())
    resp = await client.post(
        f"/api/mapsets/{mapset_id}/difficulties",
        json={"id": difficulty_id, "encrypted_name": _FAKE_ENC},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    _check(resp.json())

    # GET /mapsets/{id}/difficulties
    resp = await client.get(f"/api/mapsets/{mapset_id}/difficulties")
    assert resp.status_code == 200
    _check(resp.json())

    # GET /difficulties/{id}
    resp = await client.get(f"/api/difficulties/{difficulty_id}")
    assert resp.status_code == 200
    _check(resp.json())

    # --- Create section ---
    section_id = str(uuid4())
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json={
            "id": section_id,
            "encrypted_name": _FAKE_ENC,
            "encrypted_start_time_ms": _FAKE_ENC,
            "encrypted_end_time_ms": _FAKE_ENC,
            "encrypted_sort_order": _FAKE_ENC,
        },
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    _check(resp.json())

    # GET /difficulties/{id}/sections
    resp = await client.get(f"/api/difficulties/{difficulty_id}/sections")
    assert resp.status_code == 200
    _check(resp.json())

    # GET /difficulties/{id}/sections/{section_id}
    resp = await client.get(
        f"/api/difficulties/{difficulty_id}/sections/{section_id}"
    )
    assert resp.status_code == 200
    _check(resp.json())

    # --- Upload section .osu version ---
    version_id = str(uuid4())
    base_version_id = str(uuid4())
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section_id}/osu",
        json={
            "id": version_id,
            "encrypted_content": _FAKE_ENC,
            "base_version": {
                "id": base_version_id,
                "encrypted_content": _FAKE_ENC,
            },
        },
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    _check(resp.json())

    # GET /difficulties/{id}/sections/{section_id}/osu (active version)
    resp = await client.get(
        f"/api/difficulties/{difficulty_id}/sections/{section_id}/osu"
    )
    assert resp.status_code == 200
    _check(resp.json())

    # GET /difficulties/{id}/base.osu
    resp = await client.get(f"/api/difficulties/{difficulty_id}/base.osu")
    assert resp.status_code == 200
    _check(resp.json())

    # GET version history
    resp = await client.get(
        f"/api/difficulties/{difficulty_id}/sections/{section_id}/osu/versions"
    )
    assert resp.status_code == 200
    _check(resp.json())

    resp = await client.get(f"/api/difficulties/{difficulty_id}/base/versions")
    assert resp.status_code == 200
    _check(resp.json())

    # --- Create post ---
    post_id = str(uuid4())
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json={
            "id": post_id,
            "tag": "general",
            "encrypted_body": _FAKE_ENC,
        },
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    _check(resp.json())

    # GET difficulty detail (includes posts and sections)
    resp = await client.get(f"/api/difficulties/{difficulty_id}")
    assert resp.status_code == 200
    _check(resp.json())

    # --- Create resource ---
    resource_id = str(uuid4())
    resp = await client.post(
        f"/api/mapsets/{mapset_id}/resources",
        json={
            "id": resource_id,
            "encrypted_name": _FAKE_ENC,
            "encrypted_url": _FAKE_ENC,
            "position": 0,
        },
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    _check(resp.json())

    # GET /mapsets/{id}/resources
    resp = await client.get(f"/api/mapsets/{mapset_id}/resources")
    assert resp.status_code == 200
    _check(resp.json())


def test_e2ee_rejects_short_encrypted_value():
    """Unit-level: _assert_encrypted_values_are_valid_base64 rejects < 28 bytes."""
    short = base64.b64encode(b"tooshort").decode()  # only 8 bytes
    with pytest.raises(AssertionError, match="minimum 28"):
        _assert_encrypted_values_are_valid_base64({"encrypted_content": short})


def test_e2ee_rejects_non_base64():
    """Unit-level: _assert_encrypted_values_are_valid_base64 rejects non-base64."""
    with pytest.raises(AssertionError, match="not valid base64"):
        _assert_encrypted_values_are_valid_base64({"encrypted_content": "not:base64!!"})


def test_e2ee_rejects_bare_field_names():
    """Unit-level: _assert_no_bare_content_keys rejects forbidden bare field names."""
    for field in ("description", "name", "body", "content", "song_length_ms",
                  "start_time_ms", "end_time_ms", "sort_order", "url"):
        with pytest.raises(AssertionError, match=f"'{field}'"):
            _assert_no_bare_content_keys({field: "some value"})


def test_e2ee_allows_encrypted_prefix():
    """Unit-level: encrypted_* keys with valid base64 >= 28 bytes pass both checks."""
    valid = _FAKE_ENC
    _check({"encrypted_content": valid, "encrypted_name": valid, "id": "abc", "title": "My Song"})
