"""Integration tests for the post CRUD HTTP routes."""

from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.models import (
    Difficulty,
    Mapset,
    MapsetMember,
    MapsetRole,
    Post,
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


def _post_payload(post_id: UUID | None = None, parent_id: UUID | None = None) -> dict:
    return {
        "id": str(post_id or uuid4()),
        "tag": "suggestion",
        "encrypted_body": "encrypted:body",
        "parent_id": str(parent_id) if parent_id else None,
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
    """Yield (user, mapset_id, difficulty_id) after creating a mapset + difficulty."""
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
# POST /difficulties/{did}/posts
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_post_succeeds(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    payload = _post_payload()
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["id"] == payload["id"]
    assert body["difficulty_id"] == difficulty_id
    assert body["tag"] == payload["tag"]
    assert body["encrypted_body"] == payload["encrypted_body"]
    assert body["parent_id"] is None
    assert "created_at" in body
    assert "updated_at" in body


@pytest.mark.asyncio
async def test_create_post_rejects_unauthenticated(client: AsyncClient):
    resp = await client.post(
        f"/api/difficulties/{uuid4()}/posts",
        json=_post_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_create_post_rejects_missing_csrf(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=_post_payload(),
        headers={"Origin": settings.FRONTEND_URL},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_create_post_rejects_non_member(client: AsyncClient):
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
        f"/api/difficulties/{diff['id']}/posts",
        json=_post_payload(),
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_create_post_with_parent_succeeds(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty

    parent_payload = _post_payload()
    parent_resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=parent_payload,
        headers=CSRF_HEADERS,
    )
    assert parent_resp.status_code == 201

    reply_payload = _post_payload(parent_id=UUID(parent_payload["id"]))
    reply_resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=reply_payload,
        headers=CSRF_HEADERS,
    )
    assert reply_resp.status_code == 201
    assert reply_resp.json()["parent_id"] == parent_payload["id"]


@pytest.mark.asyncio
async def test_create_post_rejects_parent_from_other_difficulty(
    client: AsyncClient, authed_user_with_difficulty
):
    owner, mapset_id, difficulty_id = authed_user_with_difficulty

    # Create a second difficulty in the same mapset
    diff2 = _difficulty_payload()
    resp = await client.post(
        f"/api/mapsets/{mapset_id}/difficulties", json=diff2, headers=CSRF_HEADERS
    )
    assert resp.status_code == 201

    # Create a post in the first difficulty
    parent_payload = _post_payload()
    parent_resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=parent_payload,
        headers=CSRF_HEADERS,
    )
    assert parent_resp.status_code == 201

    # Try to reply in the second difficulty referencing the first's post
    reply_payload = _post_payload(parent_id=UUID(parent_payload["id"]))
    reply_resp = await client.post(
        f"/api/difficulties/{diff2['id']}/posts",
        json=reply_payload,
        headers=CSRF_HEADERS,
    )
    assert reply_resp.status_code == 404
    assert "Parent post not found" in reply_resp.json()["detail"]


@pytest.mark.asyncio
async def test_create_post_rejects_self_parent(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    post_id = uuid4()
    payload = _post_payload(post_id=post_id, parent_id=post_id)
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404
    assert "Parent post not found" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_create_post_rejects_reply_to_reply(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty

    # Create top-level post
    top_payload = _post_payload()
    top_resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=top_payload,
        headers=CSRF_HEADERS,
    )
    assert top_resp.status_code == 201

    # Create reply to top-level post
    reply_payload = _post_payload(parent_id=UUID(top_payload["id"]))
    reply_resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=reply_payload,
        headers=CSRF_HEADERS,
    )
    assert reply_resp.status_code == 201

    # Attempt reply-to-reply (should fail)
    nested_payload = _post_payload(parent_id=UUID(reply_payload["id"]))
    nested_resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=nested_payload,
        headers=CSRF_HEADERS,
    )
    assert nested_resp.status_code == 400
    assert "Cannot reply to a reply" in nested_resp.json()["detail"]


@pytest.mark.asyncio
async def test_create_post_rejects_invalid_tag(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    payload = _post_payload()
    payload["tag"] = "invalid_tag"
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_post_rejects_missing_body(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    bad = {"id": str(uuid4()), "tag": "general"}
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=bad,
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_post_rejects_duplicate_id(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    payload = _post_payload()
    first = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert first.status_code == 201
    second = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert second.status_code == 409


# ---------------------------------------------------------------------------
# PUT /difficulties/{did}/posts/{pid}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_post_succeeds_for_author(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    payload = _post_payload()
    create_resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert create_resp.status_code == 201

    resp = await client.put(
        f"/api/difficulties/{difficulty_id}/posts/{payload['id']}",
        json={"encrypted_body": "encrypted:updated"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["encrypted_body"] == "encrypted:updated"


@pytest.mark.asyncio
async def test_update_post_rejects_non_author(
    client: AsyncClient, authed_user_with_difficulty
):
    owner, mapset_id, difficulty_id = authed_user_with_difficulty

    # Create post as owner
    payload = _post_payload()
    create_resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert create_resp.status_code == 201

    # Add a mapper member
    mapper_user = await _seed_user(80004)
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

    # Mapper tries to edit owner's post
    client.cookies.set(settings.cookie_name, create_access_token(mapper_user.id))
    resp = await client.put(
        f"/api/difficulties/{difficulty_id}/posts/{payload['id']}",
        json={"encrypted_body": "encrypted:stolen"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_update_post_rejects_owner_editing_others_post(
    client: AsyncClient, authed_user_with_difficulty
):
    owner, mapset_id, difficulty_id = authed_user_with_difficulty

    # Add a mapper member and create a post as mapper
    mapper_user = await _seed_user(80005)
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
    payload = _post_payload()
    create_resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert create_resp.status_code == 201

    # Owner tries to edit mapper's post
    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    resp = await client.put(
        f"/api/difficulties/{difficulty_id}/posts/{payload['id']}",
        json={"encrypted_body": "encrypted:changed"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_update_post_rejects_unauthenticated(client: AsyncClient):
    resp = await client.put(
        f"/api/difficulties/{uuid4()}/posts/{uuid4()}",
        json={"encrypted_body": "encrypted:x"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_update_post_rejects_non_member(client: AsyncClient):
    owner = await _seed_user(80020)
    stranger = await _seed_user(80021)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )

    # Create a post as owner
    payload = _post_payload()
    create_resp = await client.post(
        f"/api/difficulties/{diff['id']}/posts",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert create_resp.status_code == 201

    # Stranger tries to edit the post
    client.cookies.set(settings.cookie_name, create_access_token(stranger.id))
    resp = await client.put(
        f"/api/difficulties/{diff['id']}/posts/{payload['id']}",
        json={"encrypted_body": "encrypted:x"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_update_post_returns_404_for_unknown(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    resp = await client.put(
        f"/api/difficulties/{difficulty_id}/posts/{uuid4()}",
        json={"encrypted_body": "encrypted:x"},
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# DELETE /difficulties/{did}/posts/{pid}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_post_succeeds_for_author(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    payload = _post_payload()
    create_resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert create_resp.status_code == 201

    resp = await client.delete(
        f"/api/difficulties/{difficulty_id}/posts/{payload['id']}",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 204

    get_resp = await client.get(f"/api/difficulties/{difficulty_id}")
    posts = get_resp.json()["posts"]
    assert all(p["id"] != payload["id"] for p in posts)


@pytest.mark.asyncio
async def test_delete_post_succeeds_for_owner(
    client: AsyncClient, authed_user_with_difficulty
):
    owner, mapset_id, difficulty_id = authed_user_with_difficulty

    # Add a mapper member and create a post as mapper
    mapper_user = await _seed_user(80006)
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
    payload = _post_payload()
    create_resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert create_resp.status_code == 201

    # Owner deletes mapper's post
    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    resp = await client.delete(
        f"/api/difficulties/{difficulty_id}/posts/{payload['id']}",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 204

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_user.id)


@pytest.mark.asyncio
async def test_delete_post_rejects_non_author_non_owner(
    client: AsyncClient, authed_user_with_difficulty
):
    owner, mapset_id, difficulty_id = authed_user_with_difficulty

    # Add two mapper members
    mapper_a = await _seed_user(80007)
    mapper_b = await _seed_user(80008)
    factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(mapset_id),
                user_id=mapper_a.id,
                role=MapsetRole.mapper,
            )
        )
        session.add(
            MapsetMember(
                id=uuid4(),
                mapset_id=UUID(mapset_id),
                user_id=mapper_b.id,
                role=MapsetRole.mapper,
            )
        )
        await session.commit()

    # mapper_a creates a post
    client.cookies.set(settings.cookie_name, create_access_token(mapper_a.id))
    payload = _post_payload()
    create_resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert create_resp.status_code == 201

    # mapper_b tries to delete mapper_a's post
    client.cookies.set(settings.cookie_name, create_access_token(mapper_b.id))
    resp = await client.delete(
        f"/api/difficulties/{difficulty_id}/posts/{payload['id']}",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(mapper_a.id)
    await _delete_user_and_mapsets(mapper_b.id)


@pytest.mark.asyncio
async def test_delete_post_cascades_replies(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty

    parent_payload = _post_payload()
    parent_resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=parent_payload,
        headers=CSRF_HEADERS,
    )
    assert parent_resp.status_code == 201

    reply_payload = _post_payload(parent_id=UUID(parent_payload["id"]))
    reply_resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=reply_payload,
        headers=CSRF_HEADERS,
    )
    assert reply_resp.status_code == 201

    # Delete parent
    del_resp = await client.delete(
        f"/api/difficulties/{difficulty_id}/posts/{parent_payload['id']}",
        headers=CSRF_HEADERS,
    )
    assert del_resp.status_code == 204

    # Verify reply is also gone
    get_resp = await client.get(f"/api/difficulties/{difficulty_id}")
    posts = get_resp.json()["posts"]
    assert all(
        p["id"] not in {parent_payload["id"], reply_payload["id"]} for p in posts
    )


@pytest.mark.asyncio
async def test_delete_post_rejects_unauthenticated(client: AsyncClient):
    resp = await client.delete(
        f"/api/difficulties/{uuid4()}/posts/{uuid4()}",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_delete_post_rejects_non_member(client: AsyncClient):
    owner = await _seed_user(80022)
    stranger = await _seed_user(80023)

    client.cookies.set(settings.cookie_name, create_access_token(owner.id))
    ms = _mapset_payload()
    await client.post("/api/mapsets", json=ms, headers=CSRF_HEADERS)
    diff = _difficulty_payload()
    await client.post(
        f"/api/mapsets/{ms['id']}/difficulties", json=diff, headers=CSRF_HEADERS
    )

    # Create a post as owner
    payload = _post_payload()
    create_resp = await client.post(
        f"/api/difficulties/{diff['id']}/posts",
        json=payload,
        headers=CSRF_HEADERS,
    )
    assert create_resp.status_code == 201

    # Stranger tries to delete the post
    client.cookies.set(settings.cookie_name, create_access_token(stranger.id))
    resp = await client.delete(
        f"/api/difficulties/{diff['id']}/posts/{payload['id']}",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 403

    await _delete_user_and_mapsets(owner.id)
    await _delete_user_and_mapsets(stranger.id)


@pytest.mark.asyncio
async def test_delete_post_returns_404_for_unknown(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    resp = await client.delete(
        f"/api/difficulties/{difficulty_id}/posts/{uuid4()}",
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_post_rejects_null_body(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    bad = {"id": str(uuid4()), "tag": "general", "encrypted_body": None}
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=bad,
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_post_rejects_oversized_body(
    client: AsyncClient, authed_user_with_difficulty
):
    _, _, difficulty_id = authed_user_with_difficulty
    bad = {"id": str(uuid4()), "tag": "general", "encrypted_body": "x" * 70_000}
    resp = await client.post(
        f"/api/difficulties/{difficulty_id}/posts",
        json=bad,
        headers=CSRF_HEADERS,
    )
    assert resp.status_code == 422
