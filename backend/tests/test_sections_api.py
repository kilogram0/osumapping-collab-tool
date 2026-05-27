"""Integration tests for the section CRUD HTTP routes."""

from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.models import (
    DifficultyBaseOsuVersion,
    Mapset,
    MapsetMember,
    MapsetRole,
    Section,
    SectionOsuVersion,
    User,
)
from app.services.auth_service import create_access_token
from tests.conftest import test_engine

CSRF_HEADERS = {
    "X-Requested-With": "XMLHttpRequest",
    "Origin": settings.FRONTEND_URL,
}


def _mapset_payload(mapset_id: UUID | None = None) -> dict:
    return {
        "id": str(mapset_id or uuid4()),
        "title": "Test Mapset",
        "encrypted_description": "encrypted:desc",
        "encrypted_song_length_ms": "encrypted:200000",
        "passphrase_salt": "c2FsdC1iYXNlNjQ=",
        "encrypted_verification": "encrypted:verified",
    }


def _difficulty_payload(difficulty_id: UUID | None = None) -> dict:
    return {
        "id": str(difficulty_id or uuid4()),
        "encrypted_name": "encrypted:hard",
    }


def _section_payload(section_id: UUID | None = None) -> dict:
    return {
        "id": str(section_id or uuid4()),
        "encrypted_name": "encrypted:intro",
        "encrypted_start_time_ms": "encrypted:0",
        "encrypted_end_time_ms": "encrypted:30000",
        "encrypted_sort_order": "encrypted:1",
    }


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
            username=f"user-{osu_id}",
            avatar_url=f"https://a.ppy.sh/{osu_id}",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


async def _delete_user_and_mapsets(user_id: UUID) -> None:
    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        await session.execute(delete(Mapset).where(Mapset.owner_id == user_id))
        await session.execute(delete(User).where(User.id == user_id))
        await session.commit()


@pytest.fixture
async def authed_user(client: AsyncClient):
    user = await _seed_user(80001)
    client.cookies.set(settings.cookie_name, create_access_token(user.id))
    try:
        yield user
    finally:
        await _delete_user_and_mapsets(user.id)


@pytest.fixture
async def authed_user_with_difficulty(client: AsyncClient, authed_user: User):
    """Yield (user, mapset_id, difficulty_id) after creating mapset + difficulty."""
    ms = _mapset_payload()
    resp = await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    assert resp.status_code == 201

    diff = _difficulty_payload()
    resp = await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    assert resp.status_code == 201

    yield authed_user, ms["id"], diff["id"]


# ---------------------------------------------------------------------------
# POST /difficulties/{did}/sections
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_section_succeeds(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    payload = _section_payload()
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["id"] == payload["id"]
    assert body["difficulty_id"] == difficulty_id
    assert body["encrypted_name"] == payload["encrypted_name"]
    assert body["encrypted_start_time_ms"] == payload["encrypted_start_time_ms"]
    assert body["encrypted_end_time_ms"] == payload["encrypted_end_time_ms"]
    assert body["encrypted_sort_order"] == payload["encrypted_sort_order"]
    assert "created_at" in body


@pytest.mark.asyncio
async def test_create_section_rejects_unauthenticated(client: AsyncClient):
    resp = await client.post(
        f"/api/difficulties/{uuid4()}/sections",
        json=_section_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_create_section_rejects_missing_csrf(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=_section_payload(),
        headers={"Origin": settings.FRONTEND_URL},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_create_section_rejects_non_member(client: AsyncClient):
    owner = await _seed_user(80002)
    stranger = await _seed_user(80003)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )

    client.cookies.set(settings.cookie_name, create_access_token(stranger.id))
    resp = await client.post(
        f"/api/difficulties/{diff['id']}/sections",
        json=_section_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_create_section_rejects_modder(client: AsyncClient):
    owner = await _seed_user(80004)
    modder_user = await _seed_user(80005)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )

    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(ms["id"]),
                user_id=modder_user.id,
                role=MapsetRole.modder,
            )
        )
        await session.commit()

    client.cookies.set(settings.cookie_name, create_access_token(modder_user.id))
    resp = await client.post(
        f"/api/difficulties/{diff['id']}/sections",
        json=_section_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(modder_user.id)


@pytest.mark.asyncio
async def test_create_section_rejects_mapper(client: AsyncClient):
    owner = await _seed_user(80050)
    mapper_user = await _seed_user(80051)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )

    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(ms["id"]),
                user_id=mapper_user.id,
                role=MapsetRole.mapper,
            )
        )
        await session.commit()

    client.cookies.set(settings.cookie_name, create_access_token(mapper_user.id))
    resp = await client.post(
        f"/api/difficulties/{diff['id']}/sections",
        json=_section_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_create_section_rejects_duplicate_id(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    payload = _section_payload()
    first = await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert first.status_code == 201
    second = await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert second.status_code == 409


@pytest.mark.asyncio
async def test_create_section_rejects_missing_field(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    bad = {
        "id": str(uuid4()),
        "encrypted_name": "encrypted:x",
        # missing start/end/sort_order
    }
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections", json=bad, headers=CSRF_HEADERS
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_section_returns_404_for_unknown_difficulty(
    client: AsyncClient, authed_user: User
):
    resp = await client.post(
        f"/api/difficulties/{uuid4()}/sections",
        json=_section_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /difficulties/{did}/sections
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_sections_returns_created(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    payload = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=payload,
        headers=CSRF_HEADERS,
    )

    resp = await client.get(f"/api/difficulties/{difficulty_id}/sections")
    assert resp.status_code == 200
    ids = [s["id"] for s in resp.json()]
    assert payload["id"] in ids


@pytest.mark.asyncio
async def test_list_sections_returns_empty_initially(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    resp = await client.get(f"/api/difficulties/{difficulty_id}/sections")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_sections_rejects_non_member(client: AsyncClient):
    owner = await _seed_user(80006)
    stranger = await _seed_user(80007)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )

    client.cookies.set(settings.cookie_name, create_access_token(stranger.id))
    resp = await client.get(f"/api/difficulties/{diff['id']}/sections")
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_list_sections_rejects_unauthenticated(client: AsyncClient):
    resp = await client.get(f"/api/difficulties/{uuid4()}/sections")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# GET /difficulties/{did}/sections/{sid}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_section_returns_details(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    payload = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=payload,
        headers=CSRF_HEADERS,
    )

    resp = await client.get(
        f"/api/difficulties/{difficulty_id}/sections/{payload['id']}"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == payload["id"]
    assert body["difficulty_id"] == difficulty_id


@pytest.mark.asyncio
async def test_get_section_returns_404_for_wrong_difficulty(
    client: AsyncClient, authed_user_with_difficulty
):
    """Section exists but under a different difficulty_id → 404."""
    user, mapset_id, difficulty_id = authed_user_with_difficulty
    payload = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=payload,
        headers=CSRF_HEADERS,
    )

    # Create a second difficulty in the same mapset
    other_diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties",
        json=other_diff,
        headers=CSRF_HEADERS,
    )

    resp = await client.get(
        f"/api/difficulties/{other_diff['id']}/sections/{payload['id']}"
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_section_returns_404_for_unknown(
    client: AsyncClient, authed_user: User
):
    resp = await client.get(f"/api/difficulties/{uuid4()}/sections/{uuid4()}")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_section_rejects_unauthenticated(client: AsyncClient):
    resp = await client.get(f"/api/difficulties/{uuid4()}/sections/{uuid4()}")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# PATCH /difficulties/{did}/sections/{sid}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_section_owner_can_update(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    payload = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=payload,
        headers=CSRF_HEADERS,
    )

    resp = await client.patch(
        f"/api/difficulties/{difficulty_id}/sections/{payload['id']}",
        json={"encrypted_name": "encrypted:outro"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["encrypted_name"] == "encrypted:outro"
    # Omitted fields remain unchanged
    assert resp.json()["encrypted_start_time_ms"] == payload["encrypted_start_time_ms"]


@pytest.mark.asyncio
async def test_patch_section_empty_body_is_noop(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    payload = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=payload,
        headers=CSRF_HEADERS,
    )

    resp = await client.patch(
        f"/api/difficulties/{difficulty_id}/sections/{payload['id']}",
        json={},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["encrypted_name"] == payload["encrypted_name"]
    assert body["encrypted_start_time_ms"] == payload["encrypted_start_time_ms"]
    assert body["encrypted_end_time_ms"] == payload["encrypted_end_time_ms"]
    assert body["encrypted_sort_order"] == payload["encrypted_sort_order"]


@pytest.mark.asyncio
async def test_patch_section_mapper_can_update(client: AsyncClient):
    owner = await _seed_user(80008)
    mapper_user = await _seed_user(80009)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections", json=section, headers=CSRF_HEADERS
    )

    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(ms["id"]),
                user_id=mapper_user.id,
                role=MapsetRole.mapper,
            )
        )
        await session.commit()

    client.cookies.set(settings.cookie_name, create_access_token(mapper_user.id))
    resp = await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}",
        json={"encrypted_name": "encrypted:renamed"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["encrypted_name"] == "encrypted:renamed"

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_patch_section_modder_cannot_update(client: AsyncClient):
    owner = await _seed_user(80010)
    modder_user = await _seed_user(80011)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections", json=section, headers=CSRF_HEADERS
    )

    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(ms["id"]),
                user_id=modder_user.id,
                role=MapsetRole.modder,
            )
        )
        await session.commit()

    client.cookies.set(settings.cookie_name, create_access_token(modder_user.id))
    resp = await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}",
        json={"encrypted_name": "encrypted:hijack"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(modder_user.id)


@pytest.mark.asyncio
async def test_patch_section_returns_404_for_unknown(
    client: AsyncClient, authed_user: User
):
    resp = await client.patch(
        f"/api/difficulties/{uuid4()}/sections/{uuid4()}",
        json={"encrypted_name": "encrypted:x"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_patch_section_rejects_unauthenticated(client: AsyncClient):
    resp = await client.patch(
        f"/api/difficulties/{uuid4()}/sections/{uuid4()}",
        json={"encrypted_name": "encrypted:x"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# DELETE /difficulties/{did}/sections/{sid}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_section_owner_can_delete(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    payload = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=payload,
        headers=CSRF_HEADERS,
    )

    resp = await client.delete(
        f"/api/difficulties/{difficulty_id}/sections/{payload['id']}",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 204

    get_resp = await client.get(
        f"/api/difficulties/{difficulty_id}/sections/{payload['id']}"
    )
    assert get_resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_section_removes_row(
    client: AsyncClient, authed_user_with_difficulty
):
    """Deleting a section removes the section row from the DB."""
    _, _, difficulty_id = authed_user_with_difficulty
    payload = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=payload,
        headers=CSRF_HEADERS,
    )

    await client.delete(
        f"/api/difficulties/{difficulty_id}/sections/{payload['id']}",
        headers=CSRF_HEADERS,
    )

    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        row = await session.get(Section, UUID(payload["id"]))
    assert row is None


@pytest.mark.asyncio
async def test_delete_section_mapper_cannot_delete(client: AsyncClient):
    owner = await _seed_user(80012)
    mapper_user = await _seed_user(80013)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections", json=section, headers=CSRF_HEADERS
    )

    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(ms["id"]),
                user_id=mapper_user.id,
                role=MapsetRole.mapper,
            )
        )
        await session.commit()

    client.cookies.set(settings.cookie_name, create_access_token(mapper_user.id))
    resp = await client.delete(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_delete_section_returns_404_for_unknown(
    client: AsyncClient, authed_user: User
):
    resp = await client.delete(
        f"/api/difficulties/{uuid4()}/sections/{uuid4()}", headers=CSRF_HEADERS
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_section_rejects_unauthenticated(client: AsyncClient):
    resp = await client.delete(
        f"/api/difficulties/{uuid4()}/sections/{uuid4()}", headers=CSRF_HEADERS
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Schema validation — null and oversized fields
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_section_rejects_null_name(
    client: AsyncClient, authed_user_with_difficulty
):
    """encrypted_name is non-nullable; sending null must be rejected at 422."""
    _, _, difficulty_id = authed_user_with_difficulty
    bad = _section_payload()
    bad["encrypted_name"] = None
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections", json=bad, headers=CSRF_HEADERS
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_section_rejects_oversized_name(
    client: AsyncClient, authed_user_with_difficulty
):
    """encrypted_name over _NAME_CT_MAX (2048) must be rejected at 422."""
    _, _, difficulty_id = authed_user_with_difficulty
    bad = _section_payload()
    bad["encrypted_name"] = "x" * 4_096
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections", json=bad, headers=CSRF_HEADERS
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_section_rejects_oversized_time(
    client: AsyncClient, authed_user_with_difficulty
):
    """encrypted_start_time_ms over _TIME_CT_MAX (256) must be rejected at 422."""
    _, _, difficulty_id = authed_user_with_difficulty
    bad = _section_payload()
    bad["encrypted_start_time_ms"] = "x" * 512
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections", json=bad, headers=CSRF_HEADERS
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_patch_section_rejects_null_name(
    client: AsyncClient, authed_user_with_difficulty
):
    """Sending encrypted_name: null must be rejected at 422 (non-nullable column)."""
    _, _, difficulty_id = authed_user_with_difficulty
    payload = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=payload,
        headers=CSRF_HEADERS,
    )
    resp = await client.patch(
        f"/api/difficulties/{difficulty_id}/sections/{payload['id']}",
        json={"encrypted_name": None},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Wrong difficulty_id for PATCH and DELETE
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_section_returns_404_for_wrong_difficulty(
    client: AsyncClient, authed_user_with_difficulty
):
    """Section exists but the URL uses a different difficulty_id → 404."""
    user, mapset_id, difficulty_id = authed_user_with_difficulty
    payload = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=payload,
        headers=CSRF_HEADERS,
    )

    other_diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties",
        json=other_diff,
        headers=CSRF_HEADERS,
    )

    resp = await client.patch(
        f"/api/difficulties/{other_diff['id']}/sections/{payload['id']}",
        json={"encrypted_name": "encrypted:hijack"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_section_returns_404_for_wrong_difficulty(
    client: AsyncClient, authed_user_with_difficulty
):
    """Section exists but the URL uses a different difficulty_id → 404."""
    user, mapset_id, difficulty_id = authed_user_with_difficulty
    payload = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=payload,
        headers=CSRF_HEADERS,
    )

    other_diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties",
        json=other_diff,
        headers=CSRF_HEADERS,
    )

    resp = await client.delete(
        f"/api/difficulties/{other_diff['id']}/sections/{payload['id']}",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Helpers for .osu upload tests
# ---------------------------------------------------------------------------


def _osu_payload(version_id=None, content="encrypted:osu") -> dict:
    return {
        "id": str(version_id or uuid4()),
        "encrypted_content": content,
    }


def _osu_payload_with_base(
    version_id=None,
    content="encrypted:osu",
    base_version_id=None,
    base_content="encrypted:base",
) -> dict:
    return {
        "id": str(version_id or uuid4()),
        "encrypted_content": content,
        "base_version": {
            "id": str(base_version_id or uuid4()),
            "encrypted_content": base_content,
        },
    }


# ---------------------------------------------------------------------------
# POST /difficulties/{did}/sections/{sid}/osu
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upload_section_osu_succeeds(
    client: AsyncClient, authed_user_with_difficulty
):
    """Owner can upload a .osu version; it becomes active."""
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    osu = _osu_payload()
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=osu,
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["id"] == osu["id"]
    assert body["section_id"] == section["id"]
    assert body["encrypted_content"] == osu["encrypted_content"]
    assert body["version"] == 1
    assert body["is_active"] is True
    assert "uploaded_by" in body


@pytest.mark.asyncio
async def test_upload_section_osu_with_base_version(
    client: AsyncClient, authed_user_with_difficulty
):
    """Upload with base_version creates both section and base versions."""
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    osu = _osu_payload_with_base()
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=osu,
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["version"] == 1
    assert body["is_active"] is True


@pytest.mark.asyncio
async def test_upload_section_osu_deactivates_previous(
    client: AsyncClient, authed_user_with_difficulty
):
    """Second upload deactivates the first and increments version."""
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    first = _osu_payload(content="encrypted:v1")
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=first,
        headers=CSRF_HEADERS,
    )

    second = _osu_payload(content="encrypted:v2")
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=second,
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["version"] == 2
    assert body["is_active"] is True

    # First version should no longer be active
    async with async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )() as session:
        result = await session.execute(
            select(SectionOsuVersion).where(SectionOsuVersion.id == first["id"])
        )
        old = result.scalar_one()
        assert old.is_active is False


@pytest.mark.asyncio
async def test_upload_section_osu_rejects_unauthenticated(client: AsyncClient):
    resp = await client.post(
        f"/api/difficulties/{uuid4()}/sections/{uuid4()}/osu",
        json=_osu_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_upload_section_osu_rejects_missing_csrf(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=_osu_payload(),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_upload_section_osu_rejects_non_member(client: AsyncClient):
    owner = await _seed_user(81001)
    outsider = await _seed_user(81002)

    # Owner creates mapset + difficulty + section
    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    sec = _section_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections", json=sec, headers=CSRF_HEADERS
    )

    # Outsider tries to upload
    client.cookies.set(settings.cookie_name, create_access_token(outsider.id))
    resp = await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu",
        json=_osu_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(outsider.id)


@pytest.mark.asyncio
async def test_upload_section_osu_rejects_modder(client: AsyncClient):
    owner = await _seed_user(82001)
    modder = await _seed_user(82002)

    # Owner creates mapset + difficulty + section; invites modder
    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    sec = _section_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections", json=sec, headers=CSRF_HEADERS
    )

    async with async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(ms["id"]),
                user_id=modder.id,
                role="modder",
            )
        )
        await session.commit()

    client.cookies.set(settings.cookie_name, create_access_token(modder.id))
    resp = await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu",
        json=_osu_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_upload_section_osu_rejects_mapper_creating_base_version(
    client: AsyncClient,
):
    """A mapper may upload section .osu but cannot bundle a base_version.

    Guards the frontend role policy from being bypassed by a crafted
    request — only the owner is allowed to mint a new base.
    """
    owner = await _seed_user(82010)
    mapper_user = await _seed_user(82011)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    sec = _section_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections", json=sec, headers=CSRF_HEADERS
    )

    async with async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(ms["id"]),
                user_id=mapper_user.id,
                role=MapsetRole.mapper,
            )
        )
        await session.commit()

    client.cookies.set(settings.cookie_name, create_access_token(mapper_user.id))

    # With base_version bundled: rejected.
    resp = await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu",
        json=_osu_payload_with_base(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    # Without base_version: accepted (mapper can still upload sections).
    resp_ok = await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu",
        json=_osu_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp_ok.status_code == 201, resp_ok.text

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_upload_section_osu_owner_can_replace_existing_base(
    client: AsyncClient, authed_user_with_difficulty
):
    """Regression: the owner-only base gate must not break the
    promote-a-new-base path after a base already exists.  Owner uploads
    twice with base_version; both succeed and the second deactivates the
    first.
    """
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    first = _osu_payload_with_base(content="encrypted:v1", base_content="encrypted:base1")
    resp1 = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=first,
        headers=CSRF_HEADERS,
    )
    assert resp1.status_code == 201, resp1.text

    second = _osu_payload_with_base(content="encrypted:v2", base_content="encrypted:base2")
    resp2 = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=second,
        headers=CSRF_HEADERS,
    )
    assert resp2.status_code == 201, resp2.text
    assert resp2.json()["version"] == 2


@pytest.mark.asyncio
async def test_upload_section_osu_returns_404_for_unknown_section(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{uuid4()}/osu",
        json=_osu_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_upload_section_osu_returns_404_for_wrong_difficulty(
    client: AsyncClient, authed_user_with_difficulty
):
    """Section exists but URL uses different difficulty_id → 404."""
    user, mapset_id, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    other_diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties",
        json=other_diff,
        headers=CSRF_HEADERS,
    )

    resp = await client.post(
        f"/api/difficulties/{other_diff['id']}/sections/{section['id']}/osu",
        json=_osu_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /difficulties/{did}/sections/{sid}/osu
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_download_section_osu_returns_active_version(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    osu = _osu_payload(content="encrypted:active")
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=osu,
        headers=CSRF_HEADERS,
    )

    resp = await client.get(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu"
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["encrypted_content"] == "encrypted:active"
    assert body["is_active"] is True


@pytest.mark.asyncio
async def test_download_section_osu_returns_404_when_none_uploaded(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    resp = await client.get(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu"
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_download_section_osu_rejects_unauthenticated(client: AsyncClient):
    resp = await client.get(f"/api/difficulties/{uuid4()}/sections/{uuid4()}/osu")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_download_section_osu_rejects_non_member(client: AsyncClient):
    owner = await _seed_user(83001)
    outsider = await _seed_user(83002)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    sec = _section_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections", json=sec, headers=CSRF_HEADERS
    )
    await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu",
        json=_osu_payload(),
        headers=CSRF_HEADERS,
    )

    client.cookies.set(settings.cookie_name, create_access_token(outsider.id))
    resp = await client.get(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu"
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(outsider.id)


@pytest.mark.asyncio
async def test_download_section_osu_returns_404_for_wrong_difficulty(
    client: AsyncClient, authed_user_with_difficulty
):
    user, mapset_id, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=_osu_payload(),
        headers=CSRF_HEADERS,
    )

    other_diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties",
        json=other_diff,
        headers=CSRF_HEADERS,
    )

    resp = await client.get(
        f"/api/difficulties/{other_diff['id']}/sections/{section['id']}/osu"
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_upload_section_osu_rejects_oversized_content(
    client: AsyncClient, authed_user_with_difficulty
):
    """encrypted_content exceeding _OSU_CONTENT_CT_MAX (1_500_000) is a 422."""
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    huge = "x" * 1_500_001
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=_osu_payload(content=huge),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_upload_section_osu_deactivates_prior_base(
    client: AsyncClient, authed_user_with_difficulty
):
    """A second upload with base_version deactivates the previous base."""
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    first = _osu_payload_with_base(content="v1", base_content="base-v1")
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=first,
        headers=CSRF_HEADERS,
    )

    second = _osu_payload_with_base(content="v2", base_content="base-v2")
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=second,
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["version"] == 2

    async with async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )() as session:
        result = await session.execute(
            select(DifficultyBaseOsuVersion).where(
                DifficultyBaseOsuVersion.id == first["base_version"]["id"]
            )
        )
        old_base = result.scalar_one()
        assert old_base.is_active is False

        result2 = await session.execute(
            select(DifficultyBaseOsuVersion).where(
                DifficultyBaseOsuVersion.id == second["base_version"]["id"]
            )
        )
        new_base = result2.scalar_one()
        assert new_base.is_active is True
        assert new_base.version == 2


@pytest.mark.asyncio
async def test_upload_section_osu_links_base_to_section_version(
    client: AsyncClient, authed_user_with_difficulty
):
    """The new base row's source_section_version_id points to the new section version."""
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    osu = _osu_payload_with_base()
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=osu,
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 201, resp.text

    async with async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )() as session:
        result = await session.execute(
            select(DifficultyBaseOsuVersion).where(
                DifficultyBaseOsuVersion.id == osu["base_version"]["id"]
            )
        )
        base = result.scalar_one()
        assert base.source_section_version_id == UUID(osu["id"])


# ---------------------------------------------------------------------------
# GET /difficulties/{did}/base.osu
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_download_base_osu_returns_active_base(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    osu = _osu_payload_with_base(content="encrypted:section", base_content="encrypted:base")
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=osu,
        headers=CSRF_HEADERS,
    )

    resp = await client.get(f"/api/difficulties/{difficulty_id}/base.osu")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["encrypted_content"] == "encrypted:base"
    assert "id" in body


@pytest.mark.asyncio
async def test_download_base_osu_returns_404_when_none_uploaded(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    resp = await client.get(f"/api/difficulties/{difficulty_id}/base.osu")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_download_base_osu_rejects_unauthenticated(client: AsyncClient):
    resp = await client.get(f"/api/difficulties/{uuid4()}/base.osu")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_download_base_osu_rejects_non_member(client: AsyncClient):
    owner = await _seed_user(84001)
    outsider = await _seed_user(84002)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    sec = _section_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections", json=sec, headers=CSRF_HEADERS
    )
    await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu",
        json=_osu_payload_with_base(),
        headers=CSRF_HEADERS,
    )

    client.cookies.set(settings.cookie_name, create_access_token(outsider.id))
    resp = await client.get(f"/api/difficulties/{diff['id']}/base.osu")
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(outsider.id)


# ---------------------------------------------------------------------------
# GET /difficulties/{did}/sections/{sid}/osu/versions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_section_osu_versions_returns_all_versions(
    client: AsyncClient, authed_user_with_difficulty
):
    """Uploading twice produces two versions; list returns both ordered newest first."""
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    first = _osu_payload(content="encrypted:v1")
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=first,
        headers=CSRF_HEADERS,
    )

    second = _osu_payload(content="encrypted:v2")
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=second,
        headers=CSRF_HEADERS,
    )

    resp = await client.get(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu/versions"
    )
    assert resp.status_code == 200, resp.text
    versions = resp.json()
    assert len(versions) == 2
    # Newest first
    assert versions[0]["version"] == 2
    assert versions[0]["is_active"] is True
    assert versions[1]["version"] == 1
    assert versions[1]["is_active"] is False


@pytest.mark.asyncio
async def test_list_section_osu_versions_rejects_non_member(client: AsyncClient):
    owner = await _seed_user(85001)
    outsider = await _seed_user(85002)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    sec = _section_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections", json=sec, headers=CSRF_HEADERS
    )

    client.cookies.set(settings.cookie_name, create_access_token(outsider.id))
    resp = await client.get(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu/versions"
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(outsider.id)


@pytest.mark.asyncio
async def test_list_section_osu_versions_rejects_unauthenticated(client: AsyncClient):
    resp = await client.get(
        f"/api/difficulties/{uuid4()}/sections/{uuid4()}/osu/versions"
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_list_section_osu_versions_returns_404_for_wrong_difficulty(
    client: AsyncClient, authed_user_with_difficulty
):
    """Section exists but URL uses a different difficulty_id → 404."""
    user, mapset_id, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    other_diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties",
        json=other_diff,
        headers=CSRF_HEADERS,
    )

    resp = await client.get(
        f"/api/difficulties/{other_diff['id']}/sections/{section['id']}/osu/versions"
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# POST /difficulties/{did}/sections/{sid}/osu/versions/{vid}/activate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_activate_section_osu_version_succeeds(
    client: AsyncClient, authed_user_with_difficulty
):
    """Rolling back to v1 makes it active and deactivates v2."""
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    first = _osu_payload(content="encrypted:v1")
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=first,
        headers=CSRF_HEADERS,
    )

    second = _osu_payload(content="encrypted:v2")
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=second,
        headers=CSRF_HEADERS,
    )

    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu/versions/{first['id']}/activate",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == first["id"]
    assert body["is_active"] is True
    assert body["version"] == 1

    # Verify in DB that v2 is now inactive
    async with async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )() as session:
        result = await session.execute(
            select(SectionOsuVersion).where(SectionOsuVersion.id == second["id"])
        )
        old = result.scalar_one()
        assert old.is_active is False


@pytest.mark.asyncio
async def test_activate_section_osu_version_noop_when_already_active(
    client: AsyncClient, authed_user_with_difficulty
):
    """Activating the already-active version is a no-op (200)."""
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    osu = _osu_payload(content="encrypted:v1")
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=osu,
        headers=CSRF_HEADERS,
    )

    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu/versions/{osu['id']}/activate",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["is_active"] is True


@pytest.mark.asyncio
async def test_activate_section_osu_version_rejects_modder(client: AsyncClient):
    owner = await _seed_user(86001)
    modder = await _seed_user(86002)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    sec = _section_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections", json=sec, headers=CSRF_HEADERS
    )
    osu = _osu_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu",
        json=osu,
        headers=CSRF_HEADERS,
    )

    async with async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(ms["id"]),
                user_id=modder.id,
                role=MapsetRole.modder,
            )
        )
        await session.commit()

    client.cookies.set(settings.cookie_name, create_access_token(modder.id))
    resp = await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu/versions/{osu['id']}/activate",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_activate_section_osu_version_mapper_can_activate(client: AsyncClient):
    """A mapper (non-owner) can roll back a section version."""
    owner = await _seed_user(86101)
    mapper_user = await _seed_user(86102)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    sec = _section_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections", json=sec, headers=CSRF_HEADERS
    )
    first = _osu_payload(content="encrypted:v1")
    await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu",
        json=first,
        headers=CSRF_HEADERS,
    )
    second = _osu_payload(content="encrypted:v2")
    await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu",
        json=second,
        headers=CSRF_HEADERS,
    )

    async with async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(ms["id"]),
                user_id=mapper_user.id,
                role=MapsetRole.mapper,
            )
        )
        await session.commit()

    client.cookies.set(settings.cookie_name, create_access_token(mapper_user.id))
    resp = await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu/versions/{first['id']}/activate",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == first["id"]
    assert body["is_active"] is True
    assert body["version"] == 1

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_activate_section_osu_version_returns_404_for_unknown_version(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu/versions/{uuid4()}/activate",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_activate_section_osu_version_returns_404_for_wrong_difficulty(
    client: AsyncClient, authed_user_with_difficulty
):
    """Section exists but URL uses a different difficulty_id → 404."""
    user, mapset_id, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )
    osu = _osu_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=osu,
        headers=CSRF_HEADERS,
    )

    other_diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties",
        json=other_diff,
        headers=CSRF_HEADERS,
    )

    resp = await client.post(
        f"/api/difficulties/{other_diff['id']}/sections/{section['id']}/osu/versions/{osu['id']}/activate",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_activate_section_osu_version_rejects_missing_csrf(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )
    osu = _osu_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=osu,
        headers=CSRF_HEADERS,
    )

    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu/versions/{osu['id']}/activate",
        headers={"Origin": settings.FRONTEND_URL},
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# GET /difficulties/{did}/base/versions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_base_osu_versions_returns_all_versions(
    client: AsyncClient, authed_user_with_difficulty
):
    """Uploading twice with base produces two base versions; list returns both newest first."""
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    first = _osu_payload_with_base(content="v1", base_content="base-v1")
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=first,
        headers=CSRF_HEADERS,
    )

    second = _osu_payload_with_base(content="v2", base_content="base-v2")
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=second,
        headers=CSRF_HEADERS,
    )

    resp = await client.get(f"/api/difficulties/{difficulty_id}/base/versions")
    assert resp.status_code == 200, resp.text
    versions = resp.json()
    assert len(versions) == 2
    # Newest first
    assert versions[0]["version"] == 2
    assert versions[0]["is_active"] is True
    assert versions[0]["source_section_version_id"] == second["id"]
    assert versions[1]["version"] == 1
    assert versions[1]["is_active"] is False
    assert versions[1]["source_section_version_id"] == first["id"]


@pytest.mark.asyncio
async def test_list_base_osu_versions_rejects_non_member(client: AsyncClient):
    owner = await _seed_user(87001)
    outsider = await _seed_user(87002)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    sec = _section_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections", json=sec, headers=CSRF_HEADERS
    )
    await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu",
        json=_osu_payload_with_base(),
        headers=CSRF_HEADERS,
    )

    client.cookies.set(settings.cookie_name, create_access_token(outsider.id))
    resp = await client.get(f"/api/difficulties/{diff['id']}/base/versions")
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(outsider.id)


@pytest.mark.asyncio
async def test_list_base_osu_versions_rejects_unauthenticated(client: AsyncClient):
    resp = await client.get(f"/api/difficulties/{uuid4()}/base/versions")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_list_base_osu_versions_returns_empty_when_none_uploaded(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    resp = await client.get(f"/api/difficulties/{difficulty_id}/base/versions")
    assert resp.status_code == 200
    assert resp.json() == []


# ---------------------------------------------------------------------------
# POST /difficulties/{did}/base/versions/{vid}/activate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_activate_base_osu_version_succeeds(
    client: AsyncClient, authed_user_with_difficulty
):
    """Rolling back to base v1 makes it active and deactivates base v2."""
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    first = _osu_payload_with_base(content="v1", base_content="base-v1")
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=first,
        headers=CSRF_HEADERS,
    )

    second = _osu_payload_with_base(content="v2", base_content="base-v2")
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=second,
        headers=CSRF_HEADERS,
    )

    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/base/versions/{first['base_version']['id']}/activate",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == first["base_version"]["id"]
    assert body["is_active"] is True
    assert body["version"] == 1

    # Verify in DB that base v2 is now inactive
    async with async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )() as session:
        result = await session.execute(
            select(DifficultyBaseOsuVersion).where(
                DifficultyBaseOsuVersion.id == second["base_version"]["id"]
            )
        )
        old = result.scalar_one()
        assert old.is_active is False


@pytest.mark.asyncio
async def test_activate_base_osu_version_noop_when_already_active(
    client: AsyncClient, authed_user_with_difficulty
):
    """Activating the already-active base version is a no-op (200)."""
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )

    osu = _osu_payload_with_base()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=osu,
        headers=CSRF_HEADERS,
    )

    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/base/versions/{osu['base_version']['id']}/activate",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["is_active"] is True


@pytest.mark.asyncio
async def test_activate_base_osu_version_rejects_modder(client: AsyncClient):
    owner = await _seed_user(88001)
    modder = await _seed_user(88002)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    sec = _section_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections", json=sec, headers=CSRF_HEADERS
    )
    osu = _osu_payload_with_base()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu",
        json=osu,
        headers=CSRF_HEADERS,
    )

    async with async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(ms["id"]),
                user_id=modder.id,
                role=MapsetRole.modder,
            )
        )
        await session.commit()

    client.cookies.set(settings.cookie_name, create_access_token(modder.id))
    resp = await client.post(
        f"/api/difficulties/{diff['id']}/base/versions/{osu['base_version']['id']}/activate",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_activate_base_osu_version_mapper_can_activate(client: AsyncClient):
    """A mapper (non-owner) can roll back a base version."""
    owner = await _seed_user(88101)
    mapper_user = await _seed_user(88102)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    sec = _section_payload()
    await client.post(
        f"/api/difficulties/{diff['id']}/sections", json=sec, headers=CSRF_HEADERS
    )
    first = _osu_payload_with_base(content="v1", base_content="base-v1")
    await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu",
        json=first,
        headers=CSRF_HEADERS,
    )
    second = _osu_payload_with_base(content="v2", base_content="base-v2")
    await client.post(
        f"/api/difficulties/{diff['id']}/sections/{sec['id']}/osu",
        json=second,
        headers=CSRF_HEADERS,
    )

    async with async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(ms["id"]),
                user_id=mapper_user.id,
                role=MapsetRole.mapper,
            )
        )
        await session.commit()

    client.cookies.set(settings.cookie_name, create_access_token(mapper_user.id))
    resp = await client.post(
        f"/api/difficulties/{diff['id']}/base/versions/{first['base_version']['id']}/activate",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == first["base_version"]["id"]
    assert body["is_active"] is True
    assert body["version"] == 1

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_activate_base_osu_version_returns_404_for_unknown_version(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/base/versions/{uuid4()}/activate",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_activate_base_osu_version_returns_404_for_wrong_difficulty(
    client: AsyncClient, authed_user_with_difficulty
):
    """Base version exists but URL uses a different difficulty_id → 404."""
    user, mapset_id, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )
    osu = _osu_payload_with_base()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=osu,
        headers=CSRF_HEADERS,
    )

    other_diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties",
        json=other_diff,
        headers=CSRF_HEADERS,
    )

    resp = await client.post(
        f"/api/difficulties/{other_diff['id']}/base/versions/{osu['base_version']['id']}/activate",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_activate_base_osu_version_rejects_missing_csrf(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections",
        json=section,
        headers=CSRF_HEADERS,
    )
    osu = _osu_payload_with_base()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/osu",
        json=osu,
        headers=CSRF_HEADERS,
    )

    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/base/versions/{osu['base_version']['id']}/activate",
        headers={"Origin": settings.FRONTEND_URL},
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# PATCH /difficulties/{did}/sections/{sid}/assign
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_assign_section_default_is_null(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections", json=section, headers=CSRF_HEADERS
    )
    resp = await client.get(f"/api/difficulties/{difficulty_id}/sections/{section['id']}")
    assert resp.status_code == 200
    assert resp.json()["assigned_to"] is None


@pytest.mark.asyncio
async def test_assign_section_owner_can_assign_to_member(client: AsyncClient):
    owner = await _seed_user(80020)
    mapper_user = await _seed_user(80021)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS)
    section = _section_payload()
    await client.post(f"/api/difficulties/{diff['id']}/sections", json=section, headers=CSRF_HEADERS)

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        db.add(MapsetMember(id=uuid4(), mapset_id=UUID(ms["id"]), user_id=mapper_user.id, role=MapsetRole.mapper))
        await db.commit()

    resp = await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}/assign",
        json={"user_id": str(mapper_user.id)},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["assigned_to"] == str(mapper_user.id)

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_assign_section_owner_can_clear_assignment(client: AsyncClient):
    owner = await _seed_user(80022)
    mapper_user = await _seed_user(80023)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS)
    section = _section_payload()
    await client.post(f"/api/difficulties/{diff['id']}/sections", json=section, headers=CSRF_HEADERS)

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        db.add(MapsetMember(id=uuid4(), mapset_id=UUID(ms["id"]), user_id=mapper_user.id, role=MapsetRole.mapper))
        await db.commit()

    await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}/assign",
        json={"user_id": str(mapper_user.id)},
        headers=CSRF_HEADERS,
    )
    resp = await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}/assign",
        json={"user_id": None},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["assigned_to"] is None

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_assign_section_mapper_can_claim_unassigned(client: AsyncClient):
    owner = await _seed_user(80024)
    mapper_user = await _seed_user(80025)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS)
    section = _section_payload()
    await client.post(f"/api/difficulties/{diff['id']}/sections", json=section, headers=CSRF_HEADERS)

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        db.add(MapsetMember(id=uuid4(), mapset_id=UUID(ms["id"]), user_id=mapper_user.id, role=MapsetRole.mapper))
        await db.commit()

    client.cookies.set(settings.cookie_name, create_access_token(mapper_user.id))
    resp = await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}/assign",
        json={"user_id": str(mapper_user.id)},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["assigned_to"] == str(mapper_user.id)

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_assign_section_mapper_cannot_override_others_assignment(client: AsyncClient):
    owner = await _seed_user(80026)
    mapper1 = await _seed_user(80027)
    mapper2 = await _seed_user(80028)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS)
    section = _section_payload()
    await client.post(f"/api/difficulties/{diff['id']}/sections", json=section, headers=CSRF_HEADERS)

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        db.add(MapsetMember(id=uuid4(), mapset_id=UUID(ms["id"]), user_id=mapper1.id, role=MapsetRole.mapper))
        db.add(MapsetMember(id=uuid4(), mapset_id=UUID(ms["id"]), user_id=mapper2.id, role=MapsetRole.mapper))
        await db.commit()

    client.cookies.set(settings.cookie_name, create_access_token(mapper1.id))
    await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}/assign",
        json={"user_id": str(mapper1.id)},
        headers=CSRF_HEADERS,
    )

    client.cookies.set(settings.cookie_name, create_access_token(mapper2.id))
    resp = await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}/assign",
        json={"user_id": str(mapper2.id)},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 409

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper1.id)
    await _delete_user_and_mapsets(mapper2.id)


@pytest.mark.asyncio
async def test_assign_section_modder_cannot_assign(client: AsyncClient):
    owner = await _seed_user(80029)
    modder = await _seed_user(80030)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS)
    section = _section_payload()
    await client.post(f"/api/difficulties/{diff['id']}/sections", json=section, headers=CSRF_HEADERS)

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        db.add(MapsetMember(id=uuid4(), mapset_id=UUID(ms["id"]), user_id=modder.id, role=MapsetRole.modder))
        await db.commit()

    client.cookies.set(settings.cookie_name, create_access_token(modder.id))
    resp = await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}/assign",
        json={"user_id": str(modder.id)},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_assign_section_mapper_cannot_unassign(client: AsyncClient):
    """Mapper cannot clear an assignment (user_id: null) — only owners can."""
    owner = await _seed_user(80031)
    mapper_user = await _seed_user(80032)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS)
    section = _section_payload()
    await client.post(f"/api/difficulties/{diff['id']}/sections", json=section, headers=CSRF_HEADERS)

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        db.add(MapsetMember(id=uuid4(), mapset_id=UUID(ms["id"]), user_id=mapper_user.id, role=MapsetRole.mapper))
        await db.commit()

    client.cookies.set(settings.cookie_name, create_access_token(mapper_user.id))
    await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}/assign",
        json={"user_id": str(mapper_user.id)},
        headers=CSRF_HEADERS,
    )

    resp = await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}/assign",
        json={"user_id": None},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_assign_section_owner_can_reassign_from_one_mapper_to_another(client: AsyncClient):
    owner = await _seed_user(80033)
    mapper1 = await _seed_user(80034)
    mapper2 = await _seed_user(80035)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS)
    section = _section_payload()
    await client.post(f"/api/difficulties/{diff['id']}/sections", json=section, headers=CSRF_HEADERS)

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        db.add(MapsetMember(id=uuid4(), mapset_id=UUID(ms["id"]), user_id=mapper1.id, role=MapsetRole.mapper))
        db.add(MapsetMember(id=uuid4(), mapset_id=UUID(ms["id"]), user_id=mapper2.id, role=MapsetRole.mapper))
        await db.commit()

    await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}/assign",
        json={"user_id": str(mapper1.id)},
        headers=CSRF_HEADERS,
    )
    resp = await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}/assign",
        json={"user_id": str(mapper2.id)},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["assigned_to"] == str(mapper2.id)

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper1.id)
    await _delete_user_and_mapsets(mapper2.id)


@pytest.mark.asyncio
async def test_assign_section_non_member_cannot_assign(client: AsyncClient):
    owner = await _seed_user(80036)
    outsider = await _seed_user(80037)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS)
    section = _section_payload()
    await client.post(f"/api/difficulties/{diff['id']}/sections", json=section, headers=CSRF_HEADERS)

    client.cookies.set(settings.cookie_name, create_access_token(outsider.id))
    resp = await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}/assign",
        json={"user_id": str(outsider.id)},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(outsider.id)


@pytest.mark.asyncio
async def test_assign_section_owner_can_assign_to_modder(client: AsyncClient):
    """Owner can assign a section to a modder (e.g. newly invited member who hasn't changed role)."""
    owner = await _seed_user(80038)
    modder = await _seed_user(80039)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS)
    section = _section_payload()
    await client.post(f"/api/difficulties/{diff['id']}/sections", json=section, headers=CSRF_HEADERS)

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        db.add(MapsetMember(id=uuid4(), mapset_id=UUID(ms["id"]), user_id=modder.id, role=MapsetRole.modder))
        await db.commit()

    resp = await client.patch(
        f"/api/difficulties/{diff['id']}/sections/{section['id']}/assign",
        json={"user_id": str(modder.id)},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["assigned_to"] == str(modder.id)

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_assign_section_rejects_missing_csrf(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    section = _section_payload()
    await client.post(
        f"/api/difficulties/{difficulty_id}/sections", json=section, headers=CSRF_HEADERS
    )
    resp = await client.patch(
        f"/api/difficulties/{difficulty_id}/sections/{section['id']}/assign",
        json={"user_id": None},
        headers={"Origin": settings.FRONTEND_URL},
    )
    assert resp.status_code == 403
