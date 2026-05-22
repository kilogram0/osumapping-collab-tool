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


@pytest.mark.asyncio
async def test_get_difficulty_returns_404_for_non_owner_on_pending_row(
    client: AsyncClient,
):
    """A non-owner active member cannot see a pending-deletion difficulty via GET."""
    owner = await _seed_user(70015)
    mapper_user = await _seed_user(70016)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    # Soft-delete the difficulty.
    await client.delete(f"/api/difficulties/{diff['id']}", headers=CSRF_HEADERS)

    # Owner can still GET the pending row.
    owner_resp = await client.get(f"/api/difficulties/{diff['id']}")
    assert owner_resp.status_code == 200
    assert owner_resp.json()["delete_at"] is not None

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

    # Mapper gets 404 — pending rows are invisible to non-owners.
    client.cookies.set(settings.cookie_name, create_access_token(mapper_user.id))
    mapper_resp = await client.get(f"/api/difficulties/{diff['id']}")
    assert mapper_resp.status_code == 404

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


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
async def test_delete_difficulty_owner_schedules_purge(
    client: AsyncClient, authed_user_with_mapset
):
    """DELETE soft-deletes by setting delete_at; the row is hidden from the
    default list but still exists in the DB until the background purge fires."""
    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )

    resp = await client.delete(
        f"/api/difficulties/{payload['id']}", headers=CSRF_HEADERS
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == payload["id"]
    assert body["delete_at"] is not None

    # Default list excludes the pending row.
    list_resp = await client.get(f"/api/mapsets/{mapset_id}/difficulties")
    assert [d["id"] for d in list_resp.json()] == []

    # Owner can still re-list it via include_pending.
    list_with_pending = await client.get(
        f"/api/mapsets/{mapset_id}/difficulties?include_pending=true"
    )
    assert [d["id"] for d in list_with_pending.json()] == [payload["id"]]


@pytest.mark.asyncio
async def test_delete_difficulty_does_not_cascade_until_purge(
    client: AsyncClient, authed_user_with_mapset
):
    """Soft-delete leaves sections intact until the background purge fires."""
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
    # Sections persist during the grace period — cascade only fires when the
    # purge job hard-deletes the difficulty.
    assert len(sections) == 1


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


# ---------------------------------------------------------------------------
# GET /difficulties/{id} with sections and posts
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_difficulty_includes_sections_and_posts(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=diff, headers=CSRF_HEADERS
    )

    # Create a section
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

    # Create two posts
    post1 = {
        "id": str(uuid4()),
        "tag": "general",
        "encrypted_body": "encrypted:first",
    }
    post2 = {
        "id": str(uuid4()),
        "tag": "suggestion",
        "encrypted_body": "encrypted:second",
    }
    await client.post(
        f"/api/difficulties/{diff['id']}/posts", json=post1, headers=CSRF_HEADERS
    )
    await client.post(
        f"/api/difficulties/{diff['id']}/posts", json=post2, headers=CSRF_HEADERS
    )

    resp = await client.get(f"/api/difficulties/{diff['id']}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == diff["id"]
    assert len(body["sections"]) == 1
    assert body["sections"][0]["id"] == section_payload["id"]
    assert len(body["posts"]) == 2
    # Posts should be ordered chronologically by created_at ascending
    post_ids = [p["id"] for p in body["posts"]]
    assert post_ids == [post1["id"], post2["id"]]


# ---------------------------------------------------------------------------
# Difficulty quota cap
# ---------------------------------------------------------------------------


async def _seed_difficulties(mapset_id: UUID, count: int) -> None:
    """Insert `count` Difficulty rows directly into the DB for quota tests."""
    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        for _ in range(count):
            session.add(
                Difficulty(
                    id=uuid4(),
                    mapset_id=mapset_id,
                    encrypted_name="encrypted:seeded",
                )
            )
        await session.commit()


@pytest.mark.asyncio
async def test_difficulty_cap_rejects_when_limit_exceeded(client: AsyncClient):
    """Adding a difficulty beyond MAX_DIFFICULTIES_PER_USER (50) returns 409.

    Setup: 1 mapset with 50 seeded diffs (quota = 50). The next creation must fail.
    """
    owner = await _seed_user(79001)
    client.cookies.set(settings.cookie_name, create_access_token(owner.id))

    ms = _mapset_payload()
    resp = await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    assert resp.status_code == 201

    await _seed_difficulties(UUID(ms["id"]), 50)

    resp = await client.post(
        f"/api/mapsets/{ms['id']}/difficulties",
        json=_difficulty_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 409, resp.text

    await _delete_user_and_mapsets(owner.id)


@pytest.mark.asyncio
async def test_difficulty_cap_first_diff_does_not_increase_quota(client: AsyncClient):
    """Adding the first diff to an empty mapset does not consume extra quota.

    Setup: mapset1 with 49 diffs + mapset2 empty → quota = 49 + 1 = 50.
    Adding the first diff to mapset2 keeps quota at 50 → allowed.
    Adding a second diff to mapset2 pushes quota to 51 → rejected.
    """
    owner = await _seed_user(79002)
    client.cookies.set(settings.cookie_name, create_access_token(owner.id))

    ms1 = _mapset_payload()
    ms2 = _mapset_payload()
    for ms in (ms1, ms2):
        r = await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
        assert r.status_code == 201

    await _seed_difficulties(UUID(ms1["id"]), 49)

    # First diff in empty mapset2 — no quota increase (was already 1), must succeed.
    first = await client.post(
        f"/api/mapsets/{ms2['id']}/difficulties",
        json=_difficulty_payload(),
        headers=CSRF_HEADERS,
    )
    assert first.status_code == 201, first.text

    # Second diff in mapset2 — quota would be 51, must be rejected.
    second = await client.post(
        f"/api/mapsets/{ms2['id']}/difficulties",
        json=_difficulty_payload(),
        headers=CSRF_HEADERS,
    )
    assert second.status_code == 409, second.text

    await _delete_user_and_mapsets(owner.id)


@pytest.mark.asyncio
async def test_difficulty_cap_detail_message(client: AsyncClient):
    """409 response for quota exceeded must carry the expected detail string."""
    owner = await _seed_user(79003)
    client.cookies.set(settings.cookie_name, create_access_token(owner.id))

    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    await _seed_difficulties(UUID(ms["id"]), 50)

    resp = await client.post(
        f"/api/mapsets/{ms['id']}/difficulties",
        json=_difficulty_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "Difficulty limit reached"

    await _delete_user_and_mapsets(owner.id)


@pytest.mark.asyncio
async def test_difficulty_cap_delete_frees_slot(client: AsyncClient):
    """Deleting a difficulty decreases quota so a new one can be created."""
    owner = await _seed_user(79004)
    client.cookies.set(settings.cookie_name, create_access_token(owner.id))

    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    await _seed_difficulties(UUID(ms["id"]), 50)

    # At capacity — creating fails.
    blocked = await client.post(
        f"/api/mapsets/{ms['id']}/difficulties",
        json=_difficulty_payload(),
        headers=CSRF_HEADERS,
    )
    assert blocked.status_code == 409

    # Fetch one of the seeded diffs to get a real ID.
    list_resp = await client.get(f"/api/mapsets/{ms['id']}/difficulties")
    diff_id = list_resp.json()[0]["id"]

    await client.delete(f"/api/difficulties/{diff_id}", headers=CSRF_HEADERS)

    # Now there's a free slot — creating must succeed.
    freed = await client.post(
        f"/api/mapsets/{ms['id']}/difficulties",
        json=_difficulty_payload(),
        headers=CSRF_HEADERS,
    )
    assert freed.status_code == 201, freed.text

    await _delete_user_and_mapsets(owner.id)


@pytest.mark.asyncio
async def test_difficulty_cap_charges_mapset_owner_not_mapper(client: AsyncClient):
    """Quota is tracked against the mapset owner, not the user creating the diff.

    Setup: owner has a mapset with 50 diffs (quota full). A mapper on that
    mapset tries to add a difficulty — it must be rejected by the owner's quota,
    even though the mapper's own quota is empty.
    """
    owner = await _seed_user(79005)
    mapper_user = await _seed_user(79006)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    await _seed_difficulties(UUID(ms["id"]), 50)

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
        f"/api/mapsets/{ms['id']}/difficulties",
        json=_difficulty_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 409, resp.text

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


# ---------------------------------------------------------------------------
# Soft-delete: pending-deletion buffer, restore, include_pending toggle
# ---------------------------------------------------------------------------


async def _seed_difficulties_pending(
    mapset_id: UUID, count: int, delete_at_offset_days: float = 7.0
) -> list[UUID]:
    """Insert ``count`` Difficulty rows with delete_at set to (now + offset days)."""
    from datetime import datetime, timedelta, timezone

    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    now_naive = datetime.now(timezone.utc).replace(tzinfo=None)
    ids: list[UUID] = []
    async with factory() as session:
        for _ in range(count):
            d = Difficulty(
                id=uuid4(),
                mapset_id=mapset_id,
                encrypted_name="encrypted:pending",
                delete_at=now_naive + timedelta(days=delete_at_offset_days),
            )
            session.add(d)
            ids.append(d.id)
        await session.commit()
    return ids


@pytest.mark.asyncio
async def test_delete_difficulty_sets_delete_at(
    client: AsyncClient, authed_user_with_mapset
):
    """DELETE returns a 200 body with delete_at set ~7 days in the future."""
    from datetime import datetime, timedelta, timezone

    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )

    resp = await client.delete(
        f"/api/difficulties/{payload['id']}", headers=CSRF_HEADERS
    )
    assert resp.status_code == 200
    body = resp.json()
    delete_at = datetime.fromisoformat(body["delete_at"])
    expected = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=7)
    # Allow a generous skew for slow CI.
    assert abs((delete_at - expected).total_seconds()) < 60


@pytest.mark.asyncio
async def test_delete_difficulty_is_idempotent_when_already_pending(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )
    first = await client.delete(
        f"/api/difficulties/{payload['id']}", headers=CSRF_HEADERS
    )
    assert first.status_code == 200
    first_at = first.json()["delete_at"]

    second = await client.delete(
        f"/api/difficulties/{payload['id']}", headers=CSRF_HEADERS
    )
    assert second.status_code == 200
    # Idempotent — the timestamp doesn't reset.
    assert second.json()["delete_at"] == first_at


@pytest.mark.asyncio
async def test_delete_difficulty_frees_active_quota_slot(client: AsyncClient):
    """Scheduling deletion immediately frees an active slot so a new diff can be created."""
    owner = await _seed_user(79100)
    client.cookies.set(settings.cookie_name, create_access_token(owner.id))

    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    await _seed_difficulties(UUID(ms["id"]), 50)

    blocked = await client.post(
        f"/api/mapsets/{ms['id']}/difficulties",
        json=_difficulty_payload(),
        headers=CSRF_HEADERS,
    )
    assert blocked.status_code == 409

    list_resp = await client.get(f"/api/mapsets/{ms['id']}/difficulties")
    diff_id = list_resp.json()[0]["id"]
    await client.delete(f"/api/difficulties/{diff_id}", headers=CSRF_HEADERS)

    freed = await client.post(
        f"/api/mapsets/{ms['id']}/difficulties",
        json=_difficulty_payload(),
        headers=CSRF_HEADERS,
    )
    assert freed.status_code == 201, freed.text

    await _delete_user_and_mapsets(owner.id)


@pytest.mark.asyncio
async def test_delete_difficulty_rejects_when_buffer_full(client: AsyncClient):
    """409 + buffer-full detail when the owner has 50 pending-deletion slots."""
    owner = await _seed_user(79101)
    client.cookies.set(settings.cookie_name, create_access_token(owner.id))

    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    await _seed_difficulties_pending(UUID(ms["id"]), 50)

    # Create an additional active diff so we have something to soft-delete.
    new_diff = _difficulty_payload()
    create = await client.post(
        f"/api/mapsets/{ms['id']}/difficulties",
        json=new_diff,
        headers=CSRF_HEADERS,
    )
    assert create.status_code == 201

    resp = await client.delete(
        f"/api/difficulties/{new_diff['id']}", headers=CSRF_HEADERS
    )
    assert resp.status_code == 409
    assert "Pending-deletion limit reached" in resp.json()["detail"]

    await _delete_user_and_mapsets(owner.id)


@pytest.mark.asyncio
async def test_list_difficulties_excludes_pending_by_default(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )
    await client.delete(
        f"/api/difficulties/{payload['id']}", headers=CSRF_HEADERS
    )

    resp = await client.get(f"/api/mapsets/{mapset_id}/difficulties")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_difficulties_include_pending_owner_only(client: AsyncClient):
    """include_pending=true is honored for owners, ignored for non-owners."""
    owner = await _seed_user(79102)
    mapper_user = await _seed_user(79103)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    await client.delete(
        f"/api/difficulties/{diff['id']}", headers=CSRF_HEADERS
    )

    # Owner sees the pending row with the toggle on.
    owner_resp = await client.get(
        f"/api/mapsets/{ms['id']}/difficulties?include_pending=true"
    )
    assert [d["id"] for d in owner_resp.json()] == [diff["id"]]

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
    mapper_resp = await client.get(
        f"/api/mapsets/{ms['id']}/difficulties?include_pending=true"
    )
    # Mapper's include_pending request is silently downgraded to active-only.
    assert mapper_resp.json() == []

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_restore_difficulty_clears_delete_at(
    client: AsyncClient, authed_user_with_mapset
):
    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )
    await client.delete(
        f"/api/difficulties/{payload['id']}", headers=CSRF_HEADERS
    )

    resp = await client.post(
        f"/api/difficulties/{payload['id']}/restore", headers=CSRF_HEADERS
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["delete_at"] is None

    # Restored row shows up in the default list again.
    list_resp = await client.get(f"/api/mapsets/{mapset_id}/difficulties")
    assert [d["id"] for d in list_resp.json()] == [payload["id"]]


@pytest.mark.asyncio
async def test_restore_difficulty_rejects_when_active_quota_full(client: AsyncClient):
    """If restoring would push the owner past the active quota, return 409."""
    owner = await _seed_user(79104)
    client.cookies.set(settings.cookie_name, create_access_token(owner.id))

    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)

    # 49 active diffs in the mapset.
    await _seed_difficulties(UUID(ms["id"]), 49)
    # One pending diff in the same mapset (quota = 49, pending = 1).
    pending_ids = await _seed_difficulties_pending(UUID(ms["id"]), 1)
    # Fill quota to 50 by adding one more active diff (49 + 1 = 50).
    await _seed_difficulties(UUID(ms["id"]), 1)

    resp = await client.post(
        f"/api/difficulties/{pending_ids[0]}/restore", headers=CSRF_HEADERS
    )
    assert resp.status_code == 409
    assert "Active difficulty limit reached" in resp.json()["detail"]

    await _delete_user_and_mapsets(owner.id)


@pytest.mark.asyncio
async def test_restore_difficulty_rejects_non_owner(client: AsyncClient):
    owner = await _seed_user(79105)
    mapper_user = await _seed_user(79106)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    await client.delete(
        f"/api/difficulties/{diff['id']}", headers=CSRF_HEADERS
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
        f"/api/difficulties/{diff['id']}/restore", headers=CSRF_HEADERS
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_restore_difficulty_returns_404_for_unknown(
    client: AsyncClient, authed_user: User
):
    resp = await client.post(
        f"/api/difficulties/{uuid4()}/restore", headers=CSRF_HEADERS
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_difficulty_ghost_cannot_read_post_kick_posts(
    client: AsyncClient,
):
    """Ghost member must not receive posts created after their kick time."""
    from datetime import datetime, timezone

    owner = await _seed_user(79107)
    ghost_user = await _seed_user(79108)

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
    kick_time = datetime.now(timezone.utc).replace(tzinfo=None)
    async with factory() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(ms["id"]),
                user_id=ghost_user.id,
                role=MapsetRole.mapper,
                kicked_at=kick_time,
            )
        )
        await session.commit()

    # Post created after kick — ghost must not see it.
    post_after = {
        "id": str(uuid4()),
        "tag": "general",
        "encrypted_body": "encrypted:secret-after-kick",
    }
    await client.post(
        f"/api/difficulties/{diff['id']}/posts", json=post_after, headers=CSRF_HEADERS
    )

    client.cookies.set(settings.cookie_name, create_access_token(ghost_user.id))
    resp = await client.get(f"/api/difficulties/{diff['id']}")
    assert resp.status_code == 200
    assert all(p["id"] != post_after["id"] for p in resp.json()["posts"])

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(ghost_user.id)


@pytest.mark.asyncio
async def test_purge_expired_difficulties_deletes_past_due_rows(
    client: AsyncClient, authed_user_with_mapset
):
    """_purge_expired_difficulties hard-deletes rows whose delete_at has passed."""
    from datetime import timedelta

    from app.main import _purge_expired_difficulties

    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )
    await client.delete(
        f"/api/difficulties/{payload['id']}", headers=CSRF_HEADERS
    )

    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        diff = await session.get(Difficulty, UUID(payload["id"]))
        assert diff is not None
        diff.delete_at = diff.created_at - timedelta(seconds=1)
        await session.commit()

    await _purge_expired_difficulties(test_engine)

    get = await client.get(f"/api/difficulties/{payload['id']}")
    assert get.status_code == 404


@pytest.mark.asyncio
async def test_purge_expired_difficulties_keeps_future_rows(
    client: AsyncClient, authed_user_with_mapset
):
    from app.main import _purge_expired_difficulties

    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )
    await client.delete(
        f"/api/difficulties/{payload['id']}", headers=CSRF_HEADERS
    )

    await _purge_expired_difficulties(test_engine)

    # Still fetchable while the grace period is in the future.
    get = await client.get(f"/api/difficulties/{payload['id']}")
    assert get.status_code == 200


@pytest.mark.asyncio
async def test_purge_expired_difficulties_leaves_active_rows(
    client: AsyncClient, authed_user_with_mapset
):
    from app.main import _purge_expired_difficulties

    _, mapset_id = authed_user_with_mapset
    payload = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=payload, headers=CSRF_HEADERS
    )

    # Active row (delete_at IS NULL) must survive the purge.
    await _purge_expired_difficulties(test_engine)
    get = await client.get(f"/api/difficulties/{payload['id']}")
    assert get.status_code == 200
