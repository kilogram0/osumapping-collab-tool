"""Integration tests for the difficulty pin HTTP routes.

Pins are owner-only to create/delete; any member may list and download.
"""

from datetime import datetime, timedelta
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
    return {"id": str(difficulty_id or uuid4()), "encrypted_name": "encrypted:hard"}


def _pin_payload(pin_id: UUID | None = None) -> dict:
    return {
        "id": str(pin_id or uuid4()),
        "encrypted_label": "encrypted:version-1",
        "encrypted_content": "encrypted:full-osu-blob",
    }


async def _seed_user(osu_id: int) -> User:
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
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
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        await session.execute(delete(Mapset).where(Mapset.owner_id == user_id))
        await session.execute(delete(User).where(User.id == user_id))
        await session.commit()


async def _add_member(
    mapset_id: str,
    user_id: UUID,
    role: MapsetRole,
    kicked_at: datetime | None = None,
) -> None:
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(mapset_id),
                user_id=user_id,
                role=role,
                kicked_at=kicked_at,
            )
        )
        await session.commit()


async def _owner_with_difficulty(client: AsyncClient, osu_id: int):
    """Seed an authed owner with a mapset + difficulty; return (owner, ms_id, diff_id)."""
    owner = await _seed_user(osu_id)
    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    resp = await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    assert resp.status_code == 201
    diff = _difficulty_payload()
    resp = await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )
    assert resp.status_code == 201
    return owner, ms["id"], diff["id"]


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_owner_can_create_pin(client: AsyncClient):
    owner, _ms_id, diff_id = await _owner_with_difficulty(client, 81001)
    try:
        payload = _pin_payload()
        resp = await client.post(
            f"/api/difficulties/{diff_id}/pins", json=payload, headers=CSRF_HEADERS
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["id"] == payload["id"]
        assert body["difficulty_id"] == diff_id
        assert body["created_by"] == str(owner.id)
        # Metadata response must NOT leak the content blob.
        assert "encrypted_content" not in body
        assert body["encrypted_label"] == payload["encrypted_label"]
    finally:
        await _delete_user_and_mapsets(owner.id)


@pytest.mark.asyncio
async def test_create_pin_rejects_modder_and_mapper(client: AsyncClient):
    owner, ms_id, diff_id = await _owner_with_difficulty(client, 81002)
    modder = await _seed_user(81003)
    mapper = await _seed_user(81004)
    try:
        await _add_member(ms_id, modder.id, MapsetRole.modder)
        await _add_member(ms_id, mapper.id, MapsetRole.mapper)

        for user in (modder, mapper):
            client.cookies.set(settings.cookie_name, create_access_token(user.id))
            resp = await client.post(
                f"/api/difficulties/{diff_id}/pins",
                json=_pin_payload(),
                headers=CSRF_HEADERS,
            )
            assert resp.status_code == 403
    finally:
        await _delete_user_and_mapsets(owner.id)
        await _delete_user_and_mapsets(modder.id)
        await _delete_user_and_mapsets(mapper.id)


@pytest.mark.asyncio
async def test_create_pin_rejects_stranger(client: AsyncClient):
    owner, _ms_id, diff_id = await _owner_with_difficulty(client, 81005)
    stranger = await _seed_user(81006)
    try:
        client.cookies.set(settings.cookie_name, create_access_token(stranger.id))
        resp = await client.post(
            f"/api/difficulties/{diff_id}/pins",
            json=_pin_payload(),
            headers=CSRF_HEADERS,
        )
        assert resp.status_code == 403
    finally:
        await _delete_user_and_mapsets(owner.id)
        await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_create_pin_duplicate_id_conflicts(client: AsyncClient):
    owner, _ms_id, diff_id = await _owner_with_difficulty(client, 81007)
    try:
        payload = _pin_payload()
        resp = await client.post(
            f"/api/difficulties/{diff_id}/pins", json=payload, headers=CSRF_HEADERS
        )
        assert resp.status_code == 201
        resp = await client.post(
            f"/api/difficulties/{diff_id}/pins", json=payload, headers=CSRF_HEADERS
        )
        assert resp.status_code == 409
    finally:
        await _delete_user_and_mapsets(owner.id)


# ---------------------------------------------------------------------------
# List + get (download)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_member_can_list_and_download_pin(client: AsyncClient):
    owner, ms_id, diff_id = await _owner_with_difficulty(client, 81008)
    modder = await _seed_user(81009)
    try:
        payload = _pin_payload()
        resp = await client.post(
            f"/api/difficulties/{diff_id}/pins", json=payload, headers=CSRF_HEADERS
        )
        assert resp.status_code == 201

        await _add_member(ms_id, modder.id, MapsetRole.modder)
        client.cookies.set(settings.cookie_name, create_access_token(modder.id))

        # List returns metadata only.
        resp = await client.get(f"/api/difficulties/{diff_id}/pins")
        assert resp.status_code == 200
        rows = resp.json()
        assert len(rows) == 1
        assert rows[0]["id"] == payload["id"]
        assert "encrypted_content" not in rows[0]

        # Single fetch includes the content blob.
        resp = await client.get(f"/api/difficulties/{diff_id}/pins/{payload['id']}")
        assert resp.status_code == 200
        assert resp.json()["encrypted_content"] == payload["encrypted_content"]
    finally:
        await _delete_user_and_mapsets(owner.id)
        await _delete_user_and_mapsets(modder.id)


@pytest.mark.asyncio
async def test_list_pins_rejects_stranger(client: AsyncClient):
    owner, _ms_id, diff_id = await _owner_with_difficulty(client, 81010)
    stranger = await _seed_user(81011)
    try:
        client.cookies.set(settings.cookie_name, create_access_token(stranger.id))
        resp = await client.get(f"/api/difficulties/{diff_id}/pins")
        assert resp.status_code == 403
    finally:
        await _delete_user_and_mapsets(owner.id)
        await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_get_missing_pin_returns_404(client: AsyncClient):
    owner, _ms_id, diff_id = await _owner_with_difficulty(client, 81012)
    try:
        resp = await client.get(f"/api/difficulties/{diff_id}/pins/{uuid4()}")
        assert resp.status_code == 404
    finally:
        await _delete_user_and_mapsets(owner.id)


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_owner_can_delete_pin(client: AsyncClient):
    owner, _ms_id, diff_id = await _owner_with_difficulty(client, 81013)
    try:
        payload = _pin_payload()
        await client.post(
            f"/api/difficulties/{diff_id}/pins", json=payload, headers=CSRF_HEADERS
        )
        resp = await client.delete(
            f"/api/difficulties/{diff_id}/pins/{payload['id']}", headers=CSRF_HEADERS
        )
        assert resp.status_code == 204
        # Gone afterwards.
        resp = await client.get(f"/api/difficulties/{diff_id}/pins/{payload['id']}")
        assert resp.status_code == 404
    finally:
        await _delete_user_and_mapsets(owner.id)


@pytest.mark.asyncio
async def test_ghost_cannot_see_pin_created_after_kick(client: AsyncClient):
    """A ghost (kicked, still in grace) must not see pins created after kick."""
    owner, ms_id, diff_id = await _owner_with_difficulty(client, 81016)
    ghost = await _seed_user(81017)
    try:
        # Kicked 1 day ago — still inside the 7-day grace window, so GHOST.
        await _add_member(
            ms_id, ghost.id, MapsetRole.modder, kicked_at=datetime.utcnow() - timedelta(days=1)
        )
        # Owner pins a version *now* — i.e. after the ghost's kicked_at.
        payload = _pin_payload()
        resp = await client.post(
            f"/api/difficulties/{diff_id}/pins", json=payload, headers=CSRF_HEADERS
        )
        assert resp.status_code == 201

        client.cookies.set(settings.cookie_name, create_access_token(ghost.id))
        # List filters out the post-kick pin.
        resp = await client.get(f"/api/difficulties/{diff_id}/pins")
        assert resp.status_code == 200
        assert resp.json() == []
        # Direct fetch of the post-kick pin is 404 for the ghost.
        resp = await client.get(f"/api/difficulties/{diff_id}/pins/{payload['id']}")
        assert resp.status_code == 404
    finally:
        await _delete_user_and_mapsets(owner.id)
        await _delete_user_and_mapsets(ghost.id)


@pytest.mark.asyncio
async def test_delete_pin_rejects_modder(client: AsyncClient):
    owner, ms_id, diff_id = await _owner_with_difficulty(client, 81014)
    modder = await _seed_user(81015)
    try:
        payload = _pin_payload()
        await client.post(
            f"/api/difficulties/{diff_id}/pins", json=payload, headers=CSRF_HEADERS
        )
        await _add_member(ms_id, modder.id, MapsetRole.modder)
        client.cookies.set(settings.cookie_name, create_access_token(modder.id))
        resp = await client.delete(
            f"/api/difficulties/{diff_id}/pins/{payload['id']}", headers=CSRF_HEADERS
        )
        assert resp.status_code == 403
    finally:
        await _delete_user_and_mapsets(owner.id)
        await _delete_user_and_mapsets(modder.id)
