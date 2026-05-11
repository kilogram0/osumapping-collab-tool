"""Integration tests for the difficulty CRUD HTTP routes."""

from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.models import Difficulty, Mapset, MapsetMember, MapsetRole, Section, User
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
    user = await _seed_user(70001)
    client.cookies.set(settings.cookie_name, create_access_token(user.id))
    try:
        yield user
    finally:
        await _delete_user_and_mapsets(user.id)


@pytest.fixture
async def authed_user_with_mapset(client: AsyncClient, authed_user: User):
    """Yield (user, mapset_id) after creating a mapset via the API."""
    payload = _mapset_payload()
    resp = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert resp.status_code == 201
    yield authed_user, payload["id"]


# ---------------------------------------------------------------------------
# POST /mapsets/{id}/difficulties
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_difficulty_succeeds(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    resp = await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["id"] == payload["id"]
    assert body["mapset_id"] == mapset_id
    assert body["encrypted_name"] == payload["encrypted_name"]
    assert "created_at" in body
    assert "updated_at" in body


@pytest.mark.asyncio
async def test_create_difficulty_rejects_unauthenticated(client: AsyncClient):
    resp = await client.post(
        f"/api/mapsets/{uuid4()}/difficulties",
        json=_difficulty_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_create_difficulty_rejects_missing_csrf(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    resp = await client.post(
        f"/api/mapsets/{mapset_id}/difficulties",
        json=_difficulty_payload(),
        headers={"Origin": settings.FRONTEND_URL},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_create_difficulty_rejects_non_member(client: AsyncClient):
    owner = await _seed_user(70002)
    stranger = await _seed_user(70003)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)

    client.cookies.set(settings.cookie_name, create_access_token(stranger.id))
    resp = await client.post(
        f"/api/mapsets/{ms['id']}/difficulties",
        json=_difficulty_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_create_difficulty_rejects_modder(client: AsyncClient):
    owner = await _seed_user(70004)
    modder_user = await _seed_user(70005)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)

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
        f"/api/mapsets/{ms['id']}/difficulties",
        json=_difficulty_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(modder_user.id)


@pytest.mark.asyncio
async def test_create_difficulty_rejects_duplicate_id(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    first = await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )
    assert first.status_code == 201
    second = await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )
    assert second.status_code == 409


@pytest.mark.asyncio
async def test_create_difficulty_rejects_missing_name(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    bad = {"id": str(uuid4())}
    resp = await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=bad, headers=CSRF_HEADERS
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_difficulty_returns_404_for_unknown_mapset(
    client: AsyncClient, authed_user: User
):
    resp = await client.post(
        f"/api/mapsets/{uuid4()}/difficulties",
        json=_difficulty_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /mapsets/{id}/difficulties
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_difficulties_returns_created(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )

    resp = await client.get(f"/api/mapsets/{mapset_id}/difficulties")
    assert resp.status_code == 200
    ids = [d["id"] for d in resp.json()]
    assert payload["id"] in ids


@pytest.mark.asyncio
async def test_list_difficulties_returns_empty_for_new_mapset(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    resp = await client.get(f"/api/mapsets/{mapset_id}/difficulties")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_difficulties_rejects_non_member(client: AsyncClient):
    owner = await _seed_user(70006)
    stranger = await _seed_user(70007)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)

    client.cookies.set(settings.cookie_name, create_access_token(stranger.id))
    resp = await client.get(f"/api/mapsets/{ms['id']}/difficulties")
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_list_difficulties_rejects_unauthenticated(client: AsyncClient):
    resp = await client.get(f"/api/mapsets/{uuid4()}/difficulties")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# GET /difficulties/{id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_difficulty_returns_details(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )

    resp = await client.get(f"/api/difficulties/{payload['id']}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == payload["id"]
    assert body["mapset_id"] == mapset_id
    assert body["encrypted_name"] == payload["encrypted_name"]


@pytest.mark.asyncio
async def test_get_difficulty_returns_403_for_non_member(client: AsyncClient):
    owner = await _seed_user(70008)
    stranger = await _seed_user(70009)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )

    client.cookies.set(settings.cookie_name, create_access_token(stranger.id))
    resp = await client.get(f"/api/difficulties/{diff['id']}")
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_get_difficulty_returns_404_for_unknown(
    client: AsyncClient, authed_user: User
):
    resp = await client.get(f"/api/difficulties/{uuid4()}")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_difficulty_rejects_unauthenticated(client: AsyncClient):
    resp = await client.get(f"/api/difficulties/{uuid4()}")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# PATCH /difficulties/{id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_difficulty_owner_can_update(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )

    resp = await client.patch(
        f"/api/difficulties/{payload['id']}",
        json={"encrypted_name": "encrypted:insane"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["encrypted_name"] == "encrypted:insane"


@pytest.mark.asyncio
async def test_patch_difficulty_empty_body_is_noop(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )

    resp = await client.patch(
        f"/api/difficulties/{payload['id']}", json={}, headers=CSRF_HEADERS
    )
    assert resp.status_code == 200
    assert resp.json()["encrypted_name"] == payload["encrypted_name"]


@pytest.mark.asyncio
async def test_patch_difficulty_mapper_can_update(client: AsyncClient):
    owner = await _seed_user(70010)
    mapper_user = await _seed_user(70011)

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
    resp = await client.patch(
        f"/api/difficulties/{diff['id']}",
        json={"encrypted_name": "encrypted:mapper-rename"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["encrypted_name"] == "encrypted:mapper-rename"

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_patch_difficulty_modder_cannot_update(client: AsyncClient):
    owner = await _seed_user(70012)
    modder_user = await _seed_user(70013)

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
    resp = await client.patch(
        f"/api/difficulties/{diff['id']}",
        json={"encrypted_name": "encrypted:stolen"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(modder_user.id)


@pytest.mark.asyncio
async def test_patch_difficulty_returns_404_for_unknown(
    client: AsyncClient, authed_user: User
):
    resp = await client.patch(
        f"/api/difficulties/{uuid4()}",
        json={"encrypted_name": "encrypted:x"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_patch_difficulty_rejects_unauthenticated(client: AsyncClient):
    resp = await client.patch(
        f"/api/difficulties/{uuid4()}",
        json={"encrypted_name": "encrypted:x"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# DELETE /difficulties/{id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_difficulty_owner_can_delete(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )

    resp = await client.delete(
        f"/api/difficulties/{payload['id']}", headers=CSRF_HEADERS
    )
    assert resp.status_code == 204

    get_resp = await client.get(f"/api/difficulties/{payload['id']}")
    assert get_resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_difficulty_cascades_to_sections(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=diff, headers=CSRF_HEADERS
    )

    section_payload = {
        "id": str(uuid4()),
        "encrypted_name": "encrypted:section",
        "encrypted_start_time_ms": "encrypted:0",
        "encrypted_end_time_ms": "encrypted:10000",
        "encrypted_sort_order": "encrypted:1",
    }
    await client.post(
        f"/api/difficulties/{diff['id']}/sections",
        json=section_payload,
        headers=CSRF_HEADERS,
    )

    await client.delete(f"/api/difficulties/{diff['id']}", headers=CSRF_HEADERS)

    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        sections = (
            await session.execute(
                select(Section).where(
                    Section.difficulty_id == UUID(diff["id"])
                )
            )
        ).scalars().all()
    assert sections == []


@pytest.mark.asyncio
async def test_delete_difficulty_mapper_cannot_delete(client: AsyncClient):
    owner = await _seed_user(70014)
    mapper_user = await _seed_user(70015)

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
    resp = await client.delete(
        f"/api/difficulties/{diff['id']}", headers=CSRF_HEADERS
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_delete_difficulty_returns_404_for_unknown(
    client: AsyncClient, authed_user: User
):
    resp = await client.delete(
        f"/api/difficulties/{uuid4()}", headers=CSRF_HEADERS
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_difficulty_rejects_unauthenticated(client: AsyncClient):
    resp = await client.delete(
        f"/api/difficulties/{uuid4()}", headers=CSRF_HEADERS
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Schema validation — null and oversized fields
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_difficulty_rejects_null_name(
    client: AsyncClient, authed_user_with_mapset
):
    """encrypted_name is non-nullable; sending null must be rejected at 422."""
    _, mapset_id = authed_user_with_mapset
    bad = {"id": str(uuid4()), "encrypted_name": None}
    resp = await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=bad, headers=CSRF_HEADERS
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_difficulty_rejects_oversized_name(
    client: AsyncClient, authed_user_with_mapset
):
    """encrypted_name over _NAME_CT_MAX (2048) must be rejected at 422."""
    _, mapset_id = authed_user_with_mapset
    bad = {"id": str(uuid4()), "encrypted_name": "x" * 4_096}
    resp = await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=bad, headers=CSRF_HEADERS
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_patch_difficulty_rejects_null_name(
    client: AsyncClient, authed_user_with_mapset
):
    """Sending encrypted_name: null must be rejected at 422 (non-nullable column)."""
    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )
    resp = await client.patch(
        f"/api/difficulties/{payload['id']}",
        json={"encrypted_name": None},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 422
