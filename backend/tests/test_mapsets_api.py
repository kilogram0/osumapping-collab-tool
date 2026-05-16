"""Integration tests for the /mapsets HTTP routes."""

from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.models import Mapset, MapsetMember, MapsetRole, User
from app.services.auth_service import create_access_token
from tests.conftest import test_engine

CSRF_HEADERS = {
    "X-Requested-With": "XMLHttpRequest",
    "Origin": settings.FRONTEND_URL,
}


def _build_payload(mapset_id: UUID | None = None) -> dict:
    return {
        "id": str(mapset_id or uuid4()),
        "title": "Test Mapset",
        "encrypted_description": "encrypted:desc",
        "encrypted_song_length_ms": "encrypted:200000",
        "passphrase_salt": "c2FsdC1iYXNlNjQ=",
        "encrypted_verification": "encrypted:verified",
    }


async def _seed_user(osu_id: int) -> User:
    """Insert a User via a committed session (idempotent by osu_id).

    A prior failed test may have left mapsets owned by this osu_id;
    ``Mapset.owner_id`` is ``ondelete=RESTRICT``, so drop those first.
    """
    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        existing = (
            await session.execute(select(User.id).where(User.osu_id == osu_id))
        ).scalar_one_or_none()
        if existing is not None:
            await session.execute(
                delete(Mapset).where(Mapset.owner_id == existing)
            )
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
    """Clean up a user and all mapsets they own (cascades to members)."""
    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        await session.execute(delete(Mapset).where(Mapset.owner_id == user_id))
        await session.execute(delete(User).where(User.id == user_id))
        await session.commit()


@pytest.fixture
async def authed_user(client: AsyncClient):
    """Seed a user, attach a session cookie, yield the user, then clean up."""
    user = await _seed_user(60001)
    client.cookies.set(settings.cookie_name, create_access_token(user.id))
    try:
        yield user
    finally:
        await _delete_user_and_mapsets(user.id)


@pytest.mark.asyncio
async def test_create_mapset_succeeds_and_adds_owner_membership(
    client: AsyncClient, authed_user: User
):
    payload = _build_payload()
    response = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["id"] == payload["id"]
    assert body["title"] == payload["title"]
    assert body["encrypted_description"] == payload["encrypted_description"]
    assert body["encrypted_song_length_ms"] == payload["encrypted_song_length_ms"]
    assert body["passphrase_salt"] == payload["passphrase_salt"]
    assert body["encrypted_verification"] == payload["encrypted_verification"]
    assert body["owner_id"] == str(authed_user.id)

    # Verify a MapsetMember(owner) row was created in the same transaction.
    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        members = (
            await session.execute(
                select(MapsetMember).where(
                    MapsetMember.mapset_id == UUID(payload["id"])
                )
            )
        ).scalars().all()
    assert len(members) == 1
    assert members[0].user_id == authed_user.id
    assert members[0].role == MapsetRole.owner


@pytest.mark.asyncio
async def test_create_mapset_accepts_null_description(
    client: AsyncClient, authed_user: User
):
    payload = _build_payload()
    payload["encrypted_description"] = None
    response = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)

    assert response.status_code == 201, response.text
    assert response.json()["encrypted_description"] is None


@pytest.mark.asyncio
async def test_create_mapset_rejects_unauthenticated(client: AsyncClient):
    response = await client.post(
        "/api/mapsets", json=_build_payload(), headers=CSRF_HEADERS
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_create_mapset_rejects_missing_csrf_header(
    client: AsyncClient, authed_user: User
):
    # Origin present, X-Requested-With missing → 403.
    response = await client.post(
        "/api/mapsets",
        json=_build_payload(),
        headers={"Origin": settings.FRONTEND_URL},
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_create_mapset_rejects_duplicate_id(
    client: AsyncClient, authed_user: User
):
    payload = _build_payload()
    first = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert first.status_code == 201

    second = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert second.status_code == 409


@pytest.mark.asyncio
async def test_create_mapset_validates_payload(
    client: AsyncClient, authed_user: User
):
    bad = _build_payload()
    del bad["title"]
    response = await client.post("/api/mapsets", json=bad, headers=CSRF_HEADERS)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_mapset_rejects_empty_title(
    client: AsyncClient, authed_user: User
):
    bad = _build_payload()
    bad["title"] = ""
    response = await client.post("/api/mapsets", json=bad, headers=CSRF_HEADERS)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_mapset_rejects_oversized_title(
    client: AsyncClient, authed_user: User
):
    bad = _build_payload()
    bad["title"] = "x" * 256
    response = await client.post("/api/mapsets", json=bad, headers=CSRF_HEADERS)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_mapset_rejects_non_base64_salt(
    client: AsyncClient, authed_user: User
):
    bad = _build_payload()
    bad["passphrase_salt"] = "not base64!!"
    response = await client.post("/api/mapsets", json=bad, headers=CSRF_HEADERS)
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# GET /mapsets
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_mapsets_returns_own_mapsets(
    client: AsyncClient, authed_user: User
):
    """A user sees the mapsets they are a member of."""
    payload = _build_payload()
    create = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert create.status_code == 201

    response = await client.get("/api/mapsets")
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body, list)
    ids = [m["id"] for m in body]
    assert payload["id"] in ids


@pytest.mark.asyncio
async def test_list_mapsets_returns_empty_for_new_user(client: AsyncClient):
    """A user with no memberships gets an empty list."""
    user = await _seed_user(60002)
    client.cookies.set(settings.cookie_name, create_access_token(user.id))
    try:
        response = await client.get("/api/mapsets")
        assert response.status_code == 200
        assert response.json() == []
    finally:
        await _delete_user_and_mapsets(user.id)


@pytest.mark.asyncio
async def test_list_mapsets_excludes_non_member_mapsets(client: AsyncClient):
    """A user cannot see mapsets they are not a member of."""
    owner = await _seed_user(60003)
    other = await _seed_user(60004)

    # Create a mapset owned by `owner`
    owner_client_cookies = {settings.cookie_name: create_access_token(owner.id)}
    payload = _build_payload()
    create = await client.post(
        "/api/mapsets",
        json=payload,
        headers=CSRF_HEADERS,
        cookies=owner_client_cookies,
    )
    assert create.status_code == 201

    # `other` should not see this mapset
    client.cookies.set(settings.cookie_name, create_access_token(other.id))
    response = await client.get("/api/mapsets")
    assert response.status_code == 200
    ids = [m["id"] for m in response.json()]
    assert payload["id"] not in ids

    # Clean up
    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(other.id)


@pytest.mark.asyncio
async def test_list_mapsets_rejects_unauthenticated(client: AsyncClient):
    """Unauthenticated requests to GET /mapsets return 401."""
    response = await client.get("/api/mapsets")
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET /mapsets/{id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_mapset_returns_full_details(
    client: AsyncClient, authed_user: User
):
    """A member can fetch full mapset details."""
    payload = _build_payload()
    create = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert create.status_code == 201

    response = await client.get(f"/api/mapsets/{payload['id']}")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == payload["id"]
    assert body["title"] == payload["title"]
    assert body["encrypted_description"] == payload["encrypted_description"]
    assert body["encrypted_song_length_ms"] == payload["encrypted_song_length_ms"]
    assert body["passphrase_salt"] == payload["passphrase_salt"]
    assert body["encrypted_verification"] == payload["encrypted_verification"]
    assert body["owner_id"] == str(authed_user.id)


@pytest.mark.asyncio
async def test_get_mapset_returns_403_for_non_member(client: AsyncClient):
    """A user who is not a member receives 403."""
    owner = await _seed_user(60005)
    other = await _seed_user(60006)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    payload = _build_payload()
    create = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert create.status_code == 201

    client.cookies.set(settings.cookie_name, create_access_token(other.id))
    response = await client.get(f"/api/mapsets/{payload['id']}")
    assert response.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(other.id)


@pytest.mark.asyncio
async def test_get_mapset_returns_404_for_unknown_id(
    client: AsyncClient, authed_user: User
):
    """A request for a non-existent mapset ID returns 404."""
    response = await client.get(f"/api/mapsets/{uuid4()}")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_get_mapset_rejects_unauthenticated(client: AsyncClient):
    """Unauthenticated requests to GET /mapsets/{id} return 401."""
    response = await client.get(f"/api/mapsets/{uuid4()}")
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# PATCH /mapsets/{id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_mapset_owner_can_update(
    client: AsyncClient, authed_user: User
):
    """The mapset owner can update encrypted fields."""
    payload = _build_payload()
    create = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert create.status_code == 201

    response = await client.patch(
        f"/api/mapsets/{payload['id']}",
        json={"title": "New Title"},
        headers=CSRF_HEADERS,
    )
    assert response.status_code == 200
    assert response.json()["title"] == "New Title"
    # Omitted fields are preserved unchanged
    assert response.json()["encrypted_description"] == payload["encrypted_description"]


@pytest.mark.asyncio
async def test_patch_mapset_empty_body_returns_unchanged(
    client: AsyncClient, authed_user: User
):
    """An empty PATCH body is a no-op — all fields remain unchanged."""
    payload = _build_payload()
    create = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert create.status_code == 201

    response = await client.patch(
        f"/api/mapsets/{payload['id']}", json={}, headers=CSRF_HEADERS
    )
    assert response.status_code == 200
    body = response.json()
    assert body["title"] == payload["title"]
    assert body["encrypted_description"] == payload["encrypted_description"]
    assert body["encrypted_song_length_ms"] == payload["encrypted_song_length_ms"]


@pytest.mark.asyncio
async def test_patch_mapset_can_clear_description(
    client: AsyncClient, authed_user: User
):
    """Sending ``encrypted_description: null`` explicitly clears the field."""
    payload = _build_payload()
    create = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert create.status_code == 201
    assert create.json()["encrypted_description"] is not None

    response = await client.patch(
        f"/api/mapsets/{payload['id']}",
        json={"encrypted_description": None},
        headers=CSRF_HEADERS,
    )
    assert response.status_code == 200
    assert response.json()["encrypted_description"] is None


@pytest.mark.asyncio
async def test_patch_mapset_mapper_can_update(client: AsyncClient):
    """A mapper member can update encrypted fields."""
    owner = await _seed_user(60007)
    mapper_user = await _seed_user(60008)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    payload = _build_payload()
    create = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert create.status_code == 201
    mapset_id = payload["id"]

    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(mapset_id),
                user_id=mapper_user.id,
                role=MapsetRole.mapper,
            )
        )
        await session.commit()

    client.cookies.set(settings.cookie_name, create_access_token(mapper_user.id))
    response = await client.patch(
        f"/api/mapsets/{mapset_id}",
        json={"title": "Mapper Title"},
        headers=CSRF_HEADERS,
    )
    assert response.status_code == 200
    assert response.json()["title"] == "Mapper Title"

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_patch_mapset_modder_cannot_update(client: AsyncClient):
    """A modder member is rejected with 403."""
    owner = await _seed_user(60009)
    modder_user = await _seed_user(60010)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    payload = _build_payload()
    create = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert create.status_code == 201
    mapset_id = payload["id"]

    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(mapset_id),
                user_id=modder_user.id,
                role=MapsetRole.modder,
            )
        )
        await session.commit()

    client.cookies.set(settings.cookie_name, create_access_token(modder_user.id))
    response = await client.patch(
        f"/api/mapsets/{mapset_id}",
        json={"title": "Modder Title"},
        headers=CSRF_HEADERS,
    )
    assert response.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(modder_user.id)


@pytest.mark.asyncio
async def test_patch_mapset_non_member_gets_403(client: AsyncClient):
    """A non-member cannot update a mapset."""
    owner = await _seed_user(60011)
    stranger = await _seed_user(60012)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    payload = _build_payload()
    create = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert create.status_code == 201

    client.cookies.set(settings.cookie_name, create_access_token(stranger.id))
    response = await client.patch(
        f"/api/mapsets/{payload['id']}",
        json={"title": "Stolen"},
        headers=CSRF_HEADERS,
    )
    assert response.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_patch_mapset_returns_404_for_unknown(
    client: AsyncClient, authed_user: User
):
    response = await client.patch(
        f"/api/mapsets/{uuid4()}",
        json={"title": "x"},
        headers=CSRF_HEADERS,
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_patch_mapset_rejects_unauthenticated(client: AsyncClient):
    response = await client.patch(
        f"/api/mapsets/{uuid4()}",
        json={"title": "x"},
        headers=CSRF_HEADERS,
    )
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# DELETE /mapsets/{id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_mapset_owner_can_delete(
    client: AsyncClient, authed_user: User
):
    """The owner can delete their mapset; all member rows cascade."""
    payload = _build_payload()
    mapset_id = UUID(payload["id"])
    create = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert create.status_code == 201

    response = await client.delete(
        f"/api/mapsets/{payload['id']}", headers=CSRF_HEADERS
    )
    assert response.status_code == 204

    # Mapset row is gone
    get = await client.get(f"/api/mapsets/{payload['id']}")
    assert get.status_code == 404

    # MapsetMember rows cascaded
    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        members = (
            await session.execute(
                select(MapsetMember).where(MapsetMember.mapset_id == mapset_id)
            )
        ).scalars().all()
    assert members == []


@pytest.mark.asyncio
async def test_delete_mapset_mapper_cannot_delete(client: AsyncClient):
    """A mapper is rejected with 403."""
    owner = await _seed_user(60013)
    mapper_user = await _seed_user(60014)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    payload = _build_payload()
    create = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert create.status_code == 201
    mapset_id = payload["id"]

    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(mapset_id),
                user_id=mapper_user.id,
                role=MapsetRole.mapper,
            )
        )
        await session.commit()

    client.cookies.set(settings.cookie_name, create_access_token(mapper_user.id))
    response = await client.delete(
        f"/api/mapsets/{mapset_id}", headers=CSRF_HEADERS
    )
    assert response.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_delete_mapset_non_member_gets_403(client: AsyncClient):
    """A non-member cannot delete a mapset."""
    owner = await _seed_user(60015)
    stranger = await _seed_user(60016)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    payload = _build_payload()
    create = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert create.status_code == 201

    client.cookies.set(settings.cookie_name, create_access_token(stranger.id))
    response = await client.delete(
        f"/api/mapsets/{payload['id']}", headers=CSRF_HEADERS
    )
    assert response.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_delete_mapset_returns_404_for_unknown(
    client: AsyncClient, authed_user: User
):
    response = await client.delete(
        f"/api/mapsets/{uuid4()}", headers=CSRF_HEADERS
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_mapset_rejects_unauthenticated(client: AsyncClient):
    response = await client.delete(
        f"/api/mapsets/{uuid4()}", headers=CSRF_HEADERS
    )
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET /mapsets/{id}/members/me
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_my_membership_returns_role(
    client: AsyncClient, authed_user: User
):
    payload = _build_payload()
    create = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert create.status_code == 201

    response = await client.get(f"/api/mapsets/{payload['id']}/members/me")
    assert response.status_code == 200
    body = response.json()
    assert body["mapset_id"] == payload["id"]
    assert body["user_id"] == str(authed_user.id)
    assert body["role"] == "owner"


@pytest.mark.asyncio
async def test_get_my_membership_returns_403_for_non_member(client: AsyncClient):
    owner = await _seed_user(60017)
    other = await _seed_user(60018)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    payload = _build_payload()
    create = await client.post("/api/mapsets", json=payload, headers=CSRF_HEADERS)
    assert create.status_code == 201

    client.cookies.set(settings.cookie_name, create_access_token(other.id))
    response = await client.get(f"/api/mapsets/{payload['id']}/members/me")
    assert response.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(other.id)


@pytest.mark.asyncio
async def test_get_my_membership_returns_404_for_unknown_mapset(
    client: AsyncClient, authed_user: User
):
    response = await client.get(f"/api/mapsets/{uuid4()}/members/me")
    assert response.status_code == 404
