"""Integration tests for the section CRUD HTTP routes."""

from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.models import Mapset, MapsetMember, MapsetRole, Section, User
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
