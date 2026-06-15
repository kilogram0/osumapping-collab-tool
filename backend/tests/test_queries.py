"""Unit tests for shared query/permission helpers in app.queries."""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.models import MapsetMember, MapsetRole, Post, PostTag, Section
from app.queries import (
    MembershipKind,
    forbidden,
    get_difficulty_or_404,
    get_mapset_or_404,
    get_post_or_404,
    get_section_or_404,
    require_active,
    require_role,
    utc_now_naive,
)


def test_utc_now_naive_returns_naive_utc_now():
    before = datetime.now(timezone.utc).replace(tzinfo=None)
    now = utc_now_naive()
    after = datetime.now(timezone.utc).replace(tzinfo=None)
    assert now.tzinfo is None
    assert before <= now <= after


def test_forbidden_is_standard_403():
    exc = forbidden()
    assert isinstance(exc, HTTPException)
    assert exc.status_code == 403
    assert exc.detail == "Forbidden"


def test_require_active_returns_active_member():
    member = MapsetMember(role=MapsetRole.mapper)
    assert require_active(member) is member


def test_require_active_rejects_none():
    with pytest.raises(HTTPException) as exc_info:
        require_active(None)
    assert exc_info.value.status_code == 403


def test_require_active_rejects_ghost():
    member = MapsetMember(role=MapsetRole.mapper, kicked_at=utc_now_naive())
    with pytest.raises(HTTPException) as exc_info:
        require_active(member)
    assert exc_info.value.status_code == 403


def test_require_role_returns_matching_member():
    member = MapsetMember(role=MapsetRole.owner)
    assert require_role(member, MapsetRole.owner) is member
    assert require_role(member, MapsetRole.owner, MapsetRole.mapper) is member


def test_require_role_rejects_wrong_role():
    member = MapsetMember(role=MapsetRole.mapper)
    with pytest.raises(HTTPException) as exc_info:
        require_role(member, MapsetRole.owner)
    assert exc_info.value.status_code == 403


def test_require_role_rejects_modder_for_owner_only():
    member = MapsetMember(role=MapsetRole.modder)
    with pytest.raises(HTTPException) as exc_info:
        require_role(member, MapsetRole.owner)
    assert exc_info.value.status_code == 403


def test_require_role_rejects_none():
    with pytest.raises(HTTPException) as exc_info:
        require_role(None, MapsetRole.owner)
    assert exc_info.value.status_code == 403


def test_require_role_rejects_ghost():
    member = MapsetMember(
        role=MapsetRole.owner, kicked_at=utc_now_naive() - timedelta(days=1)
    )
    with pytest.raises(HTTPException) as exc_info:
        require_role(member, MapsetRole.owner)
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_get_mapset_or_404_found(db_session, mapset_with_owner):
    result = await get_mapset_or_404(db_session, mapset_with_owner.id)
    assert result.id == mapset_with_owner.id


@pytest.mark.asyncio
async def test_get_mapset_or_404_missing(db_session):
    with pytest.raises(HTTPException) as exc_info:
        await get_mapset_or_404(db_session, uuid4())
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_get_difficulty_or_404_found(db_session, mapset_difficulty):
    result = await get_difficulty_or_404(db_session, mapset_difficulty.id)
    assert result.id == mapset_difficulty.id


@pytest.mark.asyncio
async def test_get_difficulty_or_404_missing(db_session):
    with pytest.raises(HTTPException) as exc_info:
        await get_difficulty_or_404(db_session, uuid4())
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_get_section_or_404_found(db_session, mapset_difficulty, mapset_owner):
    section = Section(
        id=uuid4(),
        difficulty_id=mapset_difficulty.id,
        encrypted_name="encrypted:name",
        encrypted_start_time_ms="encrypted:0",
        encrypted_end_time_ms="encrypted:1000",
        encrypted_sort_order="encrypted:0",
    )
    db_session.add(section)
    await db_session.commit()

    result, mapset_id, owner_id = await get_section_or_404(
        db_session, mapset_difficulty.id, section.id
    )
    assert result.id == section.id
    assert mapset_id == mapset_difficulty.mapset_id
    assert owner_id == mapset_owner.id


@pytest.mark.asyncio
async def test_get_section_or_404_missing(db_session, mapset_difficulty):
    with pytest.raises(HTTPException) as exc_info:
        await get_section_or_404(db_session, mapset_difficulty.id, uuid4())
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_get_post_or_404_found(db_session, mapset_difficulty, mapset_owner):
    post = Post(
        id=uuid4(),
        difficulty_id=mapset_difficulty.id,
        author_id=mapset_owner.id,
        tag=PostTag.general,
        encrypted_body="encrypted:body",
        byte_size=14,
    )
    db_session.add(post)
    await db_session.commit()

    result, mapset_id, owner_id = await get_post_or_404(
        db_session, mapset_difficulty.id, post.id
    )
    assert result.id == post.id
    assert mapset_id == mapset_difficulty.mapset_id
    assert owner_id == mapset_owner.id


@pytest.mark.asyncio
async def test_get_post_or_404_missing(db_session, mapset_difficulty):
    with pytest.raises(HTTPException) as exc_info:
        await get_post_or_404(db_session, mapset_difficulty.id, uuid4())
    assert exc_info.value.status_code == 404
