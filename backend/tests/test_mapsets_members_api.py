"""Integration tests for member management routes.

Covers GET/POST/PUT/DELETE /mapsets/{id}/members[/{user_id}].
osu_ids in the 90100–90199 range to avoid collisions with other test files.
"""

from unittest.mock import AsyncMock, patch
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mapset_payload(mapset_id: UUID | None = None) -> dict:
    return {
        "id": str(mapset_id or uuid4()),
        "title": "Members Test Mapset",
        "encrypted_description": "encrypted:desc",
        "encrypted_song_length_ms": "encrypted:200000",
        "passphrase_salt": "c2FsdC1iYXNlNjQ=",
        "encrypted_verification": "encrypted:verified",
    }


async def _seed_user(osu_id: int, username: str | None = None) -> User:
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
            username=username or f"user-{osu_id}",
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
async def owner_client(client: AsyncClient):
    """Yield (client, owner_user, mapset_id) with an authenticated owner."""
    owner = await _seed_user(90100)
    client.cookies.set(settings.cookie_name, create_access_token(owner.id))

    ms = _mapset_payload()
    resp = await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    assert resp.status_code == 201

    try:
        yield client, owner, ms["id"]
    finally:
        await _delete_user_and_mapsets(owner.id)


# ---------------------------------------------------------------------------
# GET /mapsets/{id}/members
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_members_returns_owner(client: AsyncClient, owner_client):
    _, owner, mapset_id = owner_client
    resp = await client.get(f"/api/mapsets/{mapset_id}/members")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["user_id"] == str(owner.id)
    assert data[0]["role"] == "owner"
    assert data[0]["username"] == owner.username
    assert data[0]["avatar_url"] == owner.avatar_url
    assert data[0]["osu_id"] == owner.osu_id


@pytest.mark.asyncio
async def test_list_members_includes_invited_member(client: AsyncClient, owner_client):
    _, owner, mapset_id = owner_client
    modder = await _seed_user(90101, "modder-list")
    try:
        await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": "modder-list"},
            headers=CSRF_HEADERS,
        )
        resp = await client.get(f"/api/mapsets/{mapset_id}/members")
        assert resp.status_code == 200
        user_ids = {m["user_id"] for m in resp.json()}
        assert str(owner.id) in user_ids
        assert str(modder.id) in user_ids
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_list_members_rejects_unauthenticated(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    client.cookies.clear()
    resp = await client.get(f"/api/mapsets/{mapset_id}/members")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_list_members_rejects_non_member(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    stranger = await _seed_user(90102)
    client.cookies.set(settings.cookie_name, create_access_token(stranger.id))
    try:
        resp = await client.get(f"/api/mapsets/{mapset_id}/members")
        assert resp.status_code == 403
    finally:
        await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_list_members_returns_404_for_unknown_mapset(
    client: AsyncClient, owner_client
):
    resp = await client.get(f"/api/mapsets/{uuid4()}/members")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# POST /mapsets/{id}/members
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_member_succeeds(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    modder = await _seed_user(90103, "invite-target")
    try:
        resp = await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": "invite-target"},
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["user_id"] == str(modder.id)
        assert body["role"] == "modder"
        assert body["username"] == "invite-target"
        assert body["mapset_id"] == mapset_id
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_invite_member_username_is_case_insensitive(
    client: AsyncClient, owner_client
):
    """osu! usernames are case-insensitive — inviting by mixed case should resolve."""
    _, _, mapset_id = owner_client
    modder = await _seed_user(90120, "Cookiezi")
    try:
        resp = await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": "cookiezi"},
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["user_id"] == str(modder.id)
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_invite_member_rejects_unknown_username(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    with patch(
        "app.routers.members.lookup_osu_user_by_username", new_callable=AsyncMock
    ) as mock_lookup:
        mock_lookup.return_value = None
        resp = await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": "this-user-does-not-exist"},
            headers=CSRF_HEADERS,
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_invite_member_via_osu_api_creates_stub_user(
    client: AsyncClient, owner_client
):
    """Inviting a user not in the local DB falls back to the osu! API and creates a stub row."""
    _, _, mapset_id = owner_client
    osu_payload = {
        "id": 90150,
        "username": "OsuOnlyUser",
        "avatar_url": "https://a.ppy.sh/90150",
    }
    with patch(
        "app.routers.members.lookup_osu_user_by_username", new_callable=AsyncMock
    ) as mock_lookup:
        mock_lookup.return_value = osu_payload
        resp = await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": "OsuOnlyUser"},
            headers=CSRF_HEADERS,
        )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["role"] == "modder"
    assert body["username"] == "OsuOnlyUser"
    assert body["osu_id"] == 90150
    mock_lookup.assert_called_once_with("OsuOnlyUser")

    stub_id = UUID(body["user_id"])
    await _delete_user_and_mapsets(stub_id)


@pytest.mark.asyncio
async def test_invite_member_returns_429_when_rate_limited(
    client: AsyncClient, owner_client
):
    """Exceeding the osu! API lookup rate limit returns 429."""
    from app.services.rate_limit import OsuApiRateLimitedError

    _, _, mapset_id = owner_client
    with patch(
        "app.routers.members.check_and_record_osu_api_call",
        side_effect=OsuApiRateLimitedError(),
    ):
        resp = await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": "not-in-db"},
            headers=CSRF_HEADERS,
        )
    assert resp.status_code == 429


@pytest.mark.asyncio
async def test_invite_member_returns_404_when_osu_api_banned(
    client: AsyncClient, owner_client
):
    """Banned users see 404 for unknown usernames — silent degradation to DB-only mode."""
    from app.services.rate_limit import OsuApiBannedError

    _, _, mapset_id = owner_client
    with patch(
        "app.routers.members.check_and_record_osu_api_call",
        side_effect=OsuApiBannedError(),
    ):
        resp = await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": "not-in-db"},
            headers=CSRF_HEADERS,
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_invite_member_returns_502_when_osu_api_raises(
    client: AsyncClient, owner_client
):
    """If the osu! API itself fails, the endpoint propagates a 502."""
    from app.services.auth_service import AuthServiceError

    _, _, mapset_id = owner_client
    with patch(
        "app.routers.members.lookup_osu_user_by_username", new_callable=AsyncMock
    ) as mock_lookup:
        mock_lookup.side_effect = AuthServiceError("osu! API unreachable")
        resp = await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": "anyone"},
            headers=CSRF_HEADERS,
        )
    assert resp.status_code == 502
    assert "unreachable" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_invite_member_returns_502_when_upsert_fails(
    client: AsyncClient, owner_client
):
    """If upsert_user_by_osu_id raises after a successful osu! API lookup, the endpoint returns 502."""
    from app.services.auth_service import AuthServiceError

    _, _, mapset_id = owner_client
    osu_payload = {"id": 90151, "username": "FoundOnOsu", "avatar_url": "https://a.ppy.sh/90151"}
    with (
        patch(
            "app.routers.members.lookup_osu_user_by_username", new_callable=AsyncMock
        ) as mock_lookup,
        patch(
            "app.routers.members.upsert_user_by_osu_id", new_callable=AsyncMock
        ) as mock_upsert,
    ):
        mock_lookup.return_value = osu_payload
        mock_upsert.side_effect = AuthServiceError("db write failed")
        resp = await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": "FoundOnOsu"},
            headers=CSRF_HEADERS,
        )
    assert resp.status_code == 502
    assert "db write failed" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_invite_member_rejects_duplicate(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    modder = await _seed_user(90104, "invite-dup")
    try:
        await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": "invite-dup"},
            headers=CSRF_HEADERS,
        )
        resp = await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": "invite-dup"},
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 409
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_invite_member_rejects_non_owner(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    mapper = await _seed_user(90105, "non-owner-mapper")
    target = await _seed_user(90106, "invite-target-2")
    try:
        # Add mapper as member
        factory = async_sessionmaker(
            test_engine, class_=AsyncSession, expire_on_commit=False
        )
        async with factory() as session:
            session.add(
                MapsetMember(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    user_id=mapper.id,
                    role=MapsetRole.mapper,
                )
            )
            await session.commit()

        client.cookies.set(settings.cookie_name, create_access_token(mapper.id))
        resp = await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": "invite-target-2"},
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 403
    finally:
        await _delete_user_and_mapsets(mapper.id)
        await _delete_user_and_mapsets(target.id)


@pytest.mark.asyncio
async def test_invite_member_rejects_unauthenticated(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    client.cookies.clear()
    resp = await client.post(
        f"/api/mapsets/{mapset_id}/members",
        json={"username": "anyone"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_invite_member_rejects_missing_csrf(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    modder = await _seed_user(90107, "no-csrf-user")
    try:
        resp = await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": "no-csrf-user"},
            headers={"Origin": settings.FRONTEND_URL},
        )
        assert resp.status_code == 403
    finally:
        await _delete_user_and_mapsets(modder.id)


# ---------------------------------------------------------------------------
# PUT /mapsets/{id}/members/{user_id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_role_modder_to_mapper(client: AsyncClient, owner_client):
    _, owner, mapset_id = owner_client
    modder = await _seed_user(90108, "role-change-modder")
    try:
        factory = async_sessionmaker(
            test_engine, class_=AsyncSession, expire_on_commit=False
        )
        async with factory() as session:
            session.add(
                MapsetMember(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    user_id=modder.id,
                    role=MapsetRole.modder,
                )
            )
            await session.commit()

        client.cookies.set(settings.cookie_name, create_access_token(owner.id))
        resp = await client.put(
            f"/api/mapsets/{mapset_id}/members/{modder.id}",
            json={"role": "mapper"},
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["role"] == "mapper"
        assert body["username"] == "role-change-modder"
        assert body["osu_id"] == 90108
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_update_role_same_role_is_noop(client: AsyncClient, owner_client):
    _, owner, mapset_id = owner_client
    modder = await _seed_user(90109, "noop-modder")
    try:
        factory = async_sessionmaker(
            test_engine, class_=AsyncSession, expire_on_commit=False
        )
        async with factory() as session:
            session.add(
                MapsetMember(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    user_id=modder.id,
                    role=MapsetRole.modder,
                )
            )
            await session.commit()

        client.cookies.set(settings.cookie_name, create_access_token(owner.id))
        resp = await client.put(
            f"/api/mapsets/{mapset_id}/members/{modder.id}",
            json={"role": "modder"},
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 200
        assert resp.json()["role"] == "modder"
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_update_role_ownership_transfer(client: AsyncClient, owner_client):
    """Transferring ownership atomically demotes old owner to mapper."""
    _, owner, mapset_id = owner_client
    new_owner = await _seed_user(90110, "new-owner")
    try:
        factory = async_sessionmaker(
            test_engine, class_=AsyncSession, expire_on_commit=False
        )
        async with factory() as session:
            session.add(
                MapsetMember(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    user_id=new_owner.id,
                    role=MapsetRole.mapper,
                )
            )
            await session.commit()

        client.cookies.set(settings.cookie_name, create_access_token(owner.id))
        resp = await client.put(
            f"/api/mapsets/{mapset_id}/members/{new_owner.id}",
            json={"role": "owner"},
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["role"] == "owner"
        assert body["username"] == "new-owner"
        assert body["user_id"] == str(new_owner.id)

        # The demoted (old) owner is now a mapper, which is still a member —
        # regression guard for the mapper→members access invariant.
        old_owner_resp = await client.get(f"/api/mapsets/{mapset_id}/members")
        assert old_owner_resp.status_code == 200

        client.cookies.set(settings.cookie_name, create_access_token(new_owner.id))
        members_resp = await client.get(f"/api/mapsets/{mapset_id}/members")
        members = {m["user_id"]: m["role"] for m in members_resp.json()}
        assert members[str(new_owner.id)] == "owner"
        assert members[str(owner.id)] == "mapper"

        # Verify Mapset.owner_id was updated
        async with factory() as session:
            mapset = await session.get(Mapset, UUID(mapset_id))
            assert mapset.owner_id == new_owner.id
    finally:
        await _delete_user_and_mapsets(new_owner.id)


@pytest.mark.asyncio
async def test_update_role_self_demotion_rejected(client: AsyncClient, owner_client):
    _, owner, mapset_id = owner_client
    resp = await client.put(
        f"/api/mapsets/{mapset_id}/members/{owner.id}",
        json={"role": "mapper"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 409
    assert "transfer ownership" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_update_role_self_as_owner_is_noop(client: AsyncClient, owner_client):
    """Owner setting their own role to owner is a no-op (already owner)."""
    _, owner, mapset_id = owner_client
    resp = await client.put(
        f"/api/mapsets/{mapset_id}/members/{owner.id}",
        json={"role": "owner"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["role"] == "owner"


@pytest.mark.asyncio
async def test_update_role_rejects_non_owner(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    mapper = await _seed_user(90111, "non-owner-role-change")
    modder = await _seed_user(90112, "role-change-target")
    try:
        factory = async_sessionmaker(
            test_engine, class_=AsyncSession, expire_on_commit=False
        )
        async with factory() as session:
            session.add(
                MapsetMember(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    user_id=mapper.id,
                    role=MapsetRole.mapper,
                )
            )
            session.add(
                MapsetMember(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    user_id=modder.id,
                    role=MapsetRole.modder,
                )
            )
            await session.commit()

        client.cookies.set(settings.cookie_name, create_access_token(mapper.id))
        resp = await client.put(
            f"/api/mapsets/{mapset_id}/members/{modder.id}",
            json={"role": "mapper"},
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 403
    finally:
        await _delete_user_and_mapsets(mapper.id)
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_update_role_returns_404_for_non_member(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    stranger = await _seed_user(90113)
    try:
        resp = await client.put(
            f"/api/mapsets/{mapset_id}/members/{stranger.id}",
            json={"role": "mapper"},
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 404
    finally:
        await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_update_role_rejects_unauthenticated(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    client.cookies.clear()
    resp = await client.put(
        f"/api/mapsets/{mapset_id}/members/{uuid4()}",
        json={"role": "mapper"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_update_role_rejects_missing_csrf(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    modder = await _seed_user(90119, "no-csrf-put")
    try:
        factory = async_sessionmaker(
            test_engine, class_=AsyncSession, expire_on_commit=False
        )
        async with factory() as session:
            session.add(
                MapsetMember(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    user_id=modder.id,
                    role=MapsetRole.modder,
                )
            )
            await session.commit()

        resp = await client.put(
            f"/api/mapsets/{mapset_id}/members/{modder.id}",
            json={"role": "mapper"},
            headers={"Origin": settings.FRONTEND_URL},
        )
        assert resp.status_code == 403
    finally:
        await _delete_user_and_mapsets(modder.id)


# ---------------------------------------------------------------------------
# DELETE /mapsets/{id}/members/{user_id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_remove_member_succeeds(client: AsyncClient, owner_client):
    _, owner, mapset_id = owner_client
    modder = await _seed_user(90114, "remove-target")
    try:
        factory = async_sessionmaker(
            test_engine, class_=AsyncSession, expire_on_commit=False
        )
        async with factory() as session:
            session.add(
                MapsetMember(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    user_id=modder.id,
                    role=MapsetRole.modder,
                )
            )
            await session.commit()

        client.cookies.set(settings.cookie_name, create_access_token(owner.id))
        resp = await client.delete(
            f"/api/mapsets/{mapset_id}/members/{modder.id}",
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 204

        # Verify the member is gone from the list
        list_resp = await client.get(f"/api/mapsets/{mapset_id}/members")
        user_ids = {m["user_id"] for m in list_resp.json()}
        assert str(modder.id) not in user_ids
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_remove_member_rejects_self_removal(client: AsyncClient, owner_client):
    _, owner, mapset_id = owner_client
    resp = await client.delete(
        f"/api/mapsets/{mapset_id}/members/{owner.id}",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 409
    assert "transfer ownership" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_remove_member_rejects_non_owner(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    mapper = await _seed_user(90115, "non-owner-remove")
    modder = await _seed_user(90116, "remove-target-2")
    try:
        factory = async_sessionmaker(
            test_engine, class_=AsyncSession, expire_on_commit=False
        )
        async with factory() as session:
            session.add(
                MapsetMember(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    user_id=mapper.id,
                    role=MapsetRole.mapper,
                )
            )
            session.add(
                MapsetMember(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    user_id=modder.id,
                    role=MapsetRole.modder,
                )
            )
            await session.commit()

        client.cookies.set(settings.cookie_name, create_access_token(mapper.id))
        resp = await client.delete(
            f"/api/mapsets/{mapset_id}/members/{modder.id}",
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 403
    finally:
        await _delete_user_and_mapsets(mapper.id)
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_remove_member_returns_404_for_non_member(
    client: AsyncClient, owner_client
):
    _, _, mapset_id = owner_client
    stranger = await _seed_user(90117)
    try:
        resp = await client.delete(
            f"/api/mapsets/{mapset_id}/members/{stranger.id}",
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 404
    finally:
        await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_remove_member_rejects_unauthenticated(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    client.cookies.clear()
    resp = await client.delete(
        f"/api/mapsets/{mapset_id}/members/{uuid4()}",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_remove_member_rejects_missing_csrf(client: AsyncClient, owner_client):
    _, _, mapset_id = owner_client
    modder = await _seed_user(90118, "no-csrf-remove")
    try:
        factory = async_sessionmaker(
            test_engine, class_=AsyncSession, expire_on_commit=False
        )
        async with factory() as session:
            session.add(
                MapsetMember(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    user_id=modder.id,
                    role=MapsetRole.modder,
                )
            )
            await session.commit()

        resp = await client.delete(
            f"/api/mapsets/{mapset_id}/members/{modder.id}",
            headers={"Origin": settings.FRONTEND_URL},
        )
        assert resp.status_code == 403
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_remove_member_clears_section_assignments(client: AsyncClient, owner_client):
    """Kicking a member automatically clears their section assignments."""
    _, owner, mapset_id = owner_client
    mapper = await _seed_user(90120, "kick-assign-mapper")
    try:
        # Create a difficulty and section.
        diff_id = str(uuid4())
        await client.post(
            f"/api/mapsets/{mapset_id}/difficulties",
            json={"id": diff_id, "encrypted_name": "encrypted:hard"},
            headers=CSRF_HEADERS,
        )
        sec_id = str(uuid4())
        await client.post(
            f"/api/difficulties/{diff_id}/sections",
            json={
                "id": sec_id,
                "encrypted_name": "encrypted:intro",
                "encrypted_start_time_ms": "encrypted:0",
                "encrypted_end_time_ms": "encrypted:30000",
                "encrypted_sort_order": "encrypted:1",
            },
            headers=CSRF_HEADERS,
        )

        # Add mapper member.
        factory = async_sessionmaker(
            test_engine, class_=AsyncSession, expire_on_commit=False
        )
        async with factory() as session:
            session.add(
                MapsetMember(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    user_id=mapper.id,
                    role=MapsetRole.mapper,
                )
            )
            await session.commit()

        # Owner assigns the section to the mapper.
        client.cookies.set(settings.cookie_name, create_access_token(owner.id))
        assign_resp = await client.patch(
            f"/api/difficulties/{diff_id}/sections/{sec_id}/assign",
            json={"user_id": str(mapper.id)},
            headers=CSRF_HEADERS,
        )
        assert assign_resp.status_code == 200
        assert assign_resp.json()["assigned_to"] == str(mapper.id)

        # Kick the mapper.
        kick_resp = await client.delete(
            f"/api/mapsets/{mapset_id}/members/{mapper.id}",
            headers=CSRF_HEADERS,
        )
        assert kick_resp.status_code == 204

        # Section assignment must now be null.
        get_resp = await client.get(f"/api/difficulties/{diff_id}/sections/{sec_id}")
        assert get_resp.status_code == 200
        assert get_resp.json()["assigned_to"] is None
    finally:
        await _delete_user_and_mapsets(mapper.id)
