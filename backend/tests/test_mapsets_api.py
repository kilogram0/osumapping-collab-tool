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
        "encrypted_title": "encrypted:title",
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
    assert body["encrypted_title"] == payload["encrypted_title"]
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
    del bad["encrypted_title"]
    response = await client.post("/api/mapsets", json=bad, headers=CSRF_HEADERS)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_mapset_rejects_empty_title(
    client: AsyncClient, authed_user: User
):
    bad = _build_payload()
    bad["encrypted_title"] = ""
    response = await client.post("/api/mapsets", json=bad, headers=CSRF_HEADERS)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_mapset_rejects_oversized_title(
    client: AsyncClient, authed_user: User
):
    bad = _build_payload()
    bad["encrypted_title"] = "x" * 4_096
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
