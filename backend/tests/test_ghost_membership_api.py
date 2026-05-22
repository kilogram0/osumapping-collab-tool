"""Integration tests for the kicked-member (ghost) grace-period feature.

osu_ids in the 90200–90299 range to avoid collisions with other test files.

Tests cover:
- DELETE /mapsets/{id}/members/{user_id} now soft-kicks (sets kicked_at)
- Kicked member is excluded from the active roster
- Kicked member can access GET routes (mapset, difficulties, members/me)
- Kicked member difficulty list is timestamp-filtered
- Kicked member is blocked from all write routes
- GET /mapsets/kicked returns ghost memberships
- Ghost membership purge task deletes expired rows
"""

from datetime import datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.main import _purge_expired_ghost_memberships
from app.models import Difficulty, Mapset, MapsetMember, MapsetRole, User
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
        "title": "Ghost Test Mapset",
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
            username=username or f"ghost-user-{osu_id}",
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
async def owner_and_mapset(client: AsyncClient):
    """Seed an owner + mapset; yield (client, owner, mapset_id)."""
    owner = await _seed_user(90200)
    client.cookies.set(settings.cookie_name, create_access_token(owner.id))

    ms = _mapset_payload()
    resp = await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    assert resp.status_code == 201

    try:
        yield client, owner, ms["id"]
    finally:
        await _delete_user_and_mapsets(owner.id)


# ---------------------------------------------------------------------------
# Soft-kick behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kick_sets_kicked_at_not_deletes(client: AsyncClient, owner_and_mapset):
    """DELETE /members/{user_id} soft-kicks: sets kicked_at, row stays in DB."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90201, "kick-target")
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

        # Row still exists with kicked_at set
        async with factory() as session:
            row = (
                await session.execute(
                    select(MapsetMember).where(
                        MapsetMember.mapset_id == UUID(mapset_id),
                        MapsetMember.user_id == modder.id,
                    )
                )
            ).scalar_one_or_none()
        assert row is not None
        assert row.kicked_at is not None
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_reinvite_ghost_unkicks_member(client: AsyncClient, owner_and_mapset):
    """POST /members re-inviting a kicked ghost clears kicked_at and restores modder role."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90217, "reinvite-ghost")
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

        # Kick the modder
        client.cookies.set(settings.cookie_name, create_access_token(owner.id))
        resp = await client.delete(
            f"/api/mapsets/{mapset_id}/members/{modder.id}",
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 204

        # Re-invite within grace period — should succeed (not 409)
        resp = await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": modder.username},
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["user_id"] == str(modder.id)
        assert data["role"] == "modder"
        assert data["kicked_at"] is None

        # Ghost row should now be active
        async with factory() as session:
            row = (
                await session.execute(
                    select(MapsetMember).where(
                        MapsetMember.mapset_id == UUID(mapset_id),
                        MapsetMember.user_id == modder.id,
                    )
                )
            ).scalar_one_or_none()
        assert row is not None
        assert row.kicked_at is None
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_kicked_member_excluded_from_roster(client: AsyncClient, owner_and_mapset):
    """GET /members does not include kicked members."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90202, "ghost-roster")
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
        await client.delete(
            f"/api/mapsets/{mapset_id}/members/{modder.id}", headers=CSRF_HEADERS
        )

        list_resp = await client.get(f"/api/mapsets/{mapset_id}/members")
        user_ids = {m["user_id"] for m in list_resp.json()}
        assert str(modder.id) not in user_ids
        assert str(owner.id) in user_ids
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_kicked_member_cannot_be_kicked_again(
    client: AsyncClient, owner_and_mapset
):
    """Trying to DELETE an already-kicked member returns 404."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90203, "double-kick")
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
        await client.delete(
            f"/api/mapsets/{mapset_id}/members/{modder.id}", headers=CSRF_HEADERS
        )
        resp2 = await client.delete(
            f"/api/mapsets/{mapset_id}/members/{modder.id}", headers=CSRF_HEADERS
        )
        assert resp2.status_code == 404
    finally:
        await _delete_user_and_mapsets(modder.id)


# ---------------------------------------------------------------------------
# Ghost member read access
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ghost_can_get_mapset(client: AsyncClient, owner_and_mapset):
    """Kicked member can still GET the mapset during the grace period."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90204, "ghost-get-mapset")
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
        await client.delete(
            f"/api/mapsets/{mapset_id}/members/{modder.id}", headers=CSRF_HEADERS
        )

        client.cookies.set(settings.cookie_name, create_access_token(modder.id))
        resp = await client.get(f"/api/mapsets/{mapset_id}")
        assert resp.status_code == 200
        assert resp.json()["id"] == mapset_id
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_ghost_can_list_difficulties(client: AsyncClient, owner_and_mapset):
    """Kicked member can GET difficulties during the grace period."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90205, "ghost-list-diff")
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
            session.add(
                Difficulty(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    encrypted_name="encrypted:Easy",
                )
            )
            await session.commit()

        client.cookies.set(settings.cookie_name, create_access_token(owner.id))
        await client.delete(
            f"/api/mapsets/{mapset_id}/members/{modder.id}", headers=CSRF_HEADERS
        )

        client.cookies.set(settings.cookie_name, create_access_token(modder.id))
        resp = await client.get(f"/api/mapsets/{mapset_id}/difficulties")
        assert resp.status_code == 200
        assert len(resp.json()) == 1
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_ghost_difficulty_filter_excludes_post_kick(
    client: AsyncClient, owner_and_mapset
):
    """Difficulties created after kick are hidden from ghost members."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90206, "ghost-ts-filter")
    try:
        factory = async_sessionmaker(
            test_engine, class_=AsyncSession, expire_on_commit=False
        )
        # Create a difficulty before kicking
        pre_kick_diff_id = uuid4()
        async with factory() as session:
            session.add(
                MapsetMember(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    user_id=modder.id,
                    role=MapsetRole.modder,
                )
            )
            session.add(
                Difficulty(
                    id=pre_kick_diff_id,
                    mapset_id=UUID(mapset_id),
                    encrypted_name="encrypted:PreKick",
                )
            )
            await session.commit()

        client.cookies.set(settings.cookie_name, create_access_token(owner.id))
        await client.delete(
            f"/api/mapsets/{mapset_id}/members/{modder.id}", headers=CSRF_HEADERS
        )

        # Create a difficulty after the kick (post-kick timestamp via DB)
        post_kick_diff_id = uuid4()
        async with factory() as session:
            session.add(
                Difficulty(
                    id=post_kick_diff_id,
                    mapset_id=UUID(mapset_id),
                    encrypted_name="encrypted:PostKick",
                )
            )
            await session.commit()

        # Manually set the kicked_at far in the past so the pre-kick diff is
        # included but the post-kick diff is excluded.
        async with factory() as session:
            member = (
                await session.execute(
                    select(MapsetMember).where(
                        MapsetMember.mapset_id == UUID(mapset_id),
                        MapsetMember.user_id == modder.id,
                    )
                )
            ).scalar_one()
            # Set kicked_at to be between the two difficulties: use the pre-kick
            # diff's created_at + 1 second as the cutoff.
            pre_diff = await session.get(Difficulty, pre_kick_diff_id)
            post_diff = await session.get(Difficulty, post_kick_diff_id)
            # kicked_at must be >= pre_kick created_at and < post_kick created_at.
            # In practice both are created within the same test run ms apart,
            # so set kicked_at = post_kick.created_at - 1ms to simulate a clean split.
            member.kicked_at = post_diff.created_at - timedelta(milliseconds=1)
            await session.commit()

        client.cookies.set(settings.cookie_name, create_access_token(modder.id))
        resp = await client.get(f"/api/mapsets/{mapset_id}/difficulties")
        assert resp.status_code == 200
        diff_ids = {d["id"] for d in resp.json()}
        assert str(pre_kick_diff_id) in diff_ids
        assert str(post_kick_diff_id) not in diff_ids
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_ghost_can_get_my_membership(client: AsyncClient, owner_and_mapset):
    """GET /members/me returns the ghost membership with kicked_at set."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90207, "ghost-me")
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
        await client.delete(
            f"/api/mapsets/{mapset_id}/members/{modder.id}", headers=CSRF_HEADERS
        )

        client.cookies.set(settings.cookie_name, create_access_token(modder.id))
        resp = await client.get(f"/api/mapsets/{mapset_id}/members/me")
        assert resp.status_code == 200
        body = resp.json()
        assert body["kicked_at"] is not None
        assert body["user_id"] == str(modder.id)
    finally:
        await _delete_user_and_mapsets(modder.id)


# ---------------------------------------------------------------------------
# Ghost member write access blocked
# ---------------------------------------------------------------------------


async def _seed_ghost(
    owner: User,
    mapset_id: str,
    modder: User,
) -> None:
    """Insert a modder member and immediately soft-kick via the DB."""
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
                kicked_at=datetime.utcnow(),
            )
        )
        await session.commit()


@pytest.mark.asyncio
async def test_ghost_blocked_from_create_difficulty(
    client: AsyncClient, owner_and_mapset
):
    """Ghost member cannot create difficulties."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90208, "ghost-write-diff")
    try:
        await _seed_ghost(owner, mapset_id, modder)
        client.cookies.set(settings.cookie_name, create_access_token(modder.id))
        resp = await client.post(
            f"/api/mapsets/{mapset_id}/difficulties",
            json={"id": str(uuid4()), "encrypted_name": "encrypted:Blocked"},
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 403
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_ghost_blocked_from_update_mapset(
    client: AsyncClient, owner_and_mapset
):
    """Ghost member cannot PATCH the mapset."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90209, "ghost-write-mapset")
    try:
        await _seed_ghost(owner, mapset_id, modder)
        client.cookies.set(settings.cookie_name, create_access_token(modder.id))
        resp = await client.patch(
            f"/api/mapsets/{mapset_id}",
            json={"title": "Hacked Title"},
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 403
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_ghost_blocked_from_inviting_members(
    client: AsyncClient, owner_and_mapset
):
    """Ghost member cannot invite new members."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90210, "ghost-invite")
    target = await _seed_user(90211, "ghost-invite-target")
    try:
        await _seed_ghost(owner, mapset_id, modder)
        client.cookies.set(settings.cookie_name, create_access_token(modder.id))
        resp = await client.post(
            f"/api/mapsets/{mapset_id}/members",
            json={"username": "ghost-invite-target"},
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 403
    finally:
        await _delete_user_and_mapsets(modder.id)
        await _delete_user_and_mapsets(target.id)


# ---------------------------------------------------------------------------
# GET /mapsets/kicked
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_kicked_mapsets_returns_ghost_entries(
    client: AsyncClient, owner_and_mapset
):
    """GET /mapsets/kicked returns mapsets where the user has an active ghost membership."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90212, "ghost-list-kicked")
    try:
        await _seed_ghost(owner, mapset_id, modder)
        client.cookies.set(settings.cookie_name, create_access_token(modder.id))
        resp = await client.get("/api/mapsets/kicked")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        item = data[0]
        assert item["id"] == mapset_id
        assert item["kicked_at"] is not None
        assert item["access_expires_at"] is not None
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_list_kicked_mapsets_empty_for_active_member(
    client: AsyncClient, owner_and_mapset
):
    """GET /mapsets/kicked returns empty list for users with only active memberships."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90213, "active-not-kicked")
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

        client.cookies.set(settings.cookie_name, create_access_token(modder.id))
        resp = await client.get("/api/mapsets/kicked")
        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_list_kicked_mapsets_excludes_expired_grace(
    client: AsyncClient, owner_and_mapset
):
    """GET /mapsets/kicked does not include entries whose grace period has expired."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90214, "expired-ghost")
    try:
        factory = async_sessionmaker(
            test_engine, class_=AsyncSession, expire_on_commit=False
        )
        # Insert ghost row with kicked_at older than 7 days
        async with factory() as session:
            session.add(
                MapsetMember(
                    id=uuid4(),
                    mapset_id=UUID(mapset_id),
                    user_id=modder.id,
                    role=MapsetRole.modder,
                    kicked_at=datetime.utcnow() - timedelta(days=8),
                )
            )
            await session.commit()

        client.cookies.set(settings.cookie_name, create_access_token(modder.id))
        resp = await client.get("/api/mapsets/kicked")
        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        await _delete_user_and_mapsets(modder.id)


# ---------------------------------------------------------------------------
# Purge task
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_purge_removes_expired_ghost_memberships(owner_and_mapset):
    """_purge_expired_ghost_memberships deletes rows kicked more than 7 days ago."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90215, "purge-ghost")
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
                    kicked_at=datetime.utcnow() - timedelta(days=8),
                )
            )
            await session.commit()

        await _purge_expired_ghost_memberships(test_engine)

        async with factory() as session:
            row = (
                await session.execute(
                    select(MapsetMember).where(
                        MapsetMember.mapset_id == UUID(mapset_id),
                        MapsetMember.user_id == modder.id,
                    )
                )
            ).scalar_one_or_none()
        assert row is None
    finally:
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_purge_preserves_active_ghost_memberships(owner_and_mapset):
    """_purge_expired_ghost_memberships leaves rows whose grace period is still active."""
    _, owner, mapset_id = owner_and_mapset
    modder = await _seed_user(90216, "preserve-ghost")
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
                    kicked_at=datetime.utcnow() - timedelta(days=3),
                )
            )
            await session.commit()

        await _purge_expired_ghost_memberships(test_engine)

        async with factory() as session:
            row = (
                await session.execute(
                    select(MapsetMember).where(
                        MapsetMember.mapset_id == UUID(mapset_id),
                        MapsetMember.user_id == modder.id,
                    )
                )
            ).scalar_one_or_none()
        assert row is not None
        assert row.kicked_at is not None
    finally:
        await _delete_user_and_mapsets(modder.id)
