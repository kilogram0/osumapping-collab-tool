"""Tests for the MapsetMember model."""

import asyncio
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.models import Mapset, MapsetMember, MapsetRole, User


@pytest.fixture
async def mapset_owner(db_session):
    """Create and return a User that can own mapsets."""
    owner = User(
        osu_id=77777, username="owner", avatar_url="https://a.ppy.sh/77777"
    )
    db_session.add(owner)
    await db_session.commit()
    await db_session.refresh(owner)
    return owner


@pytest.fixture
async def mapset_with_owner(db_session, mapset_owner):
    """Create and return a Mapset with an owner."""
    mapset = Mapset(
        id=uuid4(),
        encrypted_title="encrypted:title",
        encrypted_description="encrypted:desc",
        encrypted_song_length_ms="encrypted:100000",
        passphrase_salt="salt",
        encrypted_verification="encrypted:verified",
        owner_id=mapset_owner.id,
    )
    db_session.add(mapset)
    await db_session.commit()
    await db_session.refresh(mapset)
    return mapset


@pytest.mark.asyncio
async def test_create_and_read_member(db_session, mapset_with_owner, mapset_owner):
    """A MapsetMember row can be inserted and queried back."""
    member = MapsetMember(
        id=uuid4(),
        mapset_id=mapset_with_owner.id,
        user_id=mapset_owner.id,
        role=MapsetRole.owner,
    )
    db_session.add(member)
    await db_session.commit()
    await db_session.refresh(member)

    assert member.role == MapsetRole.owner
    assert member.mapset_id == mapset_with_owner.id
    assert member.user_id == mapset_owner.id

    result = await db_session.execute(
        select(MapsetMember).where(MapsetMember.id == member.id)
    )
    fetched = result.scalar_one()
    assert fetched.role == MapsetRole.owner


@pytest.mark.asyncio
async def test_member_default_role_is_modder(db_session, mapset_with_owner, mapset_owner):
    """Default role should be modder when not specified."""
    member = MapsetMember(
        id=uuid4(),
        mapset_id=mapset_with_owner.id,
        user_id=mapset_owner.id,
    )
    db_session.add(member)
    await db_session.commit()
    await db_session.refresh(member)

    assert member.role == MapsetRole.modder


@pytest.mark.asyncio
async def test_member_roles_round_trip(db_session, mapset_with_owner):
    """All three enum values can be persisted and read back."""
    for idx, role in enumerate((MapsetRole.owner, MapsetRole.mapper, MapsetRole.modder)):
        user = User(
            osu_id=90000 + idx,
            username=f"user_{role.value}",
            avatar_url=f"https://a.ppy.sh/{90000 + idx}",
        )
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)

        member = MapsetMember(
            id=uuid4(),
            mapset_id=mapset_with_owner.id,
            user_id=user.id,
            role=role,
        )
        db_session.add(member)
        await db_session.commit()
        await db_session.refresh(member)
        assert member.role == role


@pytest.mark.asyncio
async def test_member_invalid_role_rejected(db_session, mapset_with_owner, mapset_owner):
    """An invalid enum string is rejected at the DB level."""
    from sqlalchemy.dialects.postgresql import insert

    stmt = (
        insert(MapsetMember)
        .values(
            id=uuid4(),
            mapset_id=mapset_with_owner.id,
            user_id=mapset_owner.id,
            role="hacker",  # invalid
        )
    )
    with pytest.raises(Exception) as exc_info:
        await db_session.execute(stmt)
        await db_session.commit()
    assert "invalid input value for enum mapsetrole" in str(exc_info.value).lower()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_member_unique_constraint(db_session, mapset_with_owner, mapset_owner):
    """A user cannot be a member of the same mapset twice."""
    member1 = MapsetMember(
        id=uuid4(),
        mapset_id=mapset_with_owner.id,
        user_id=mapset_owner.id,
        role=MapsetRole.owner,
    )
    db_session.add(member1)
    await db_session.commit()

    member2 = MapsetMember(
        id=uuid4(),
        mapset_id=mapset_with_owner.id,
        user_id=mapset_owner.id,
        role=MapsetRole.mapper,
    )
    db_session.add(member2)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_member_updated_at_advances_on_role_change(db_session, mapset_with_owner, mapset_owner):
    """Updating a member's role advances updated_at."""
    member = MapsetMember(
        id=uuid4(),
        mapset_id=mapset_with_owner.id,
        user_id=mapset_owner.id,
        role=MapsetRole.modder,
    )
    db_session.add(member)
    await db_session.commit()
    await db_session.refresh(member)

    original_updated_at = member.updated_at
    assert original_updated_at is not None

    await asyncio.sleep(0.01)

    member.role = MapsetRole.mapper
    await db_session.commit()
    await db_session.refresh(member)

    assert member.updated_at > original_updated_at


@pytest.mark.asyncio
async def test_member_cascade_delete_on_mapset(db_session, mapset_with_owner, mapset_owner):
    """Deleting a Mapset via raw SQL should cascade and delete its members."""
    member = MapsetMember(
        id=uuid4(),
        mapset_id=mapset_with_owner.id,
        user_id=mapset_owner.id,
        role=MapsetRole.owner,
    )
    db_session.add(member)
    await db_session.commit()
    await db_session.refresh(member)

    await db_session.execute(
        text("DELETE FROM mapset WHERE id = :mid"),
        {"mid": mapset_with_owner.id},
    )
    await db_session.commit()

    result = await db_session.execute(
        select(MapsetMember).where(MapsetMember.id == member.id)
    )
    assert result.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_member_cascade_delete_on_user(db_session, mapset_with_owner):
    """Deleting a User via raw SQL should cascade and delete their memberships."""
    modder = User(osu_id=100001, username="modder", avatar_url="https://a.ppy.sh/100001")
    db_session.add(modder)
    await db_session.commit()
    await db_session.refresh(modder)

    member = MapsetMember(
        id=uuid4(),
        mapset_id=mapset_with_owner.id,
        user_id=modder.id,
        role=MapsetRole.modder,
    )
    db_session.add(member)
    await db_session.commit()
    await db_session.refresh(member)

    await db_session.execute(
        text("DELETE FROM \"user\" WHERE id = :uid"),
        {"uid": modder.id},
    )
    await db_session.commit()

    result = await db_session.execute(
        select(MapsetMember).where(MapsetMember.id == member.id)
    )
    assert result.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_member_fk_violation_for_nonexistent_mapset(db_session, mapset_owner):
    """Referencing a non-existent mapset_id raises IntegrityError."""
    member = MapsetMember(
        id=uuid4(),
        mapset_id=uuid4(),  # does not exist
        user_id=mapset_owner.id,
        role=MapsetRole.modder,
    )
    db_session.add(member)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()
