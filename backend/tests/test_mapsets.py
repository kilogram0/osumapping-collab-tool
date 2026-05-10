"""Tests for the Mapset model."""

from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.models import Mapset, User


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
async def test_create_and_read_mapset(db_session, mapset_with_owner):
    """A Mapset row can be inserted and queried back."""
    mapset = mapset_with_owner

    assert mapset.created_at is not None
    assert mapset.updated_at is not None

    result = await db_session.execute(
        select(Mapset).where(Mapset.id == mapset.id)
    )
    fetched = result.scalar_one()
    assert fetched.encrypted_title == "encrypted:title"
    assert fetched.encrypted_description == "encrypted:desc"
    assert fetched.owner_id == mapset.owner_id


@pytest.mark.asyncio
async def test_mapset_owner_relationship(db_session, mapset_with_owner):
    """Mapset.owner_id links to an existing User."""
    result = await db_session.execute(
        select(Mapset).where(Mapset.id == mapset_with_owner.id)
    )
    fetched = result.scalar_one()
    assert fetched.owner_id == mapset_with_owner.owner_id


@pytest.mark.asyncio
async def test_mapset_required_fields(db_session, mapset_owner):
    """Missing required encrypted fields should raise IntegrityError."""
    mapset = Mapset(
        id=uuid4(),
        encrypted_song_length_ms="encrypted:100000",
        passphrase_salt="salt",
        encrypted_verification="encrypted:verified",
        owner_id=mapset_owner.id,
    )
    db_session.add(mapset)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_mapset_owner_restrict_delete(db_session, mapset_with_owner):
    """Deleting a User who owns a Mapset should raise IntegrityError."""
    owner_id = mapset_with_owner.owner_id

    with pytest.raises(IntegrityError):
        await db_session.execute(
            text("DELETE FROM \"user\" WHERE id = :uid"),
            {"uid": owner_id},
        )
    await db_session.rollback()


@pytest.mark.asyncio
async def test_mapset_description_is_nullable(db_session, mapset_owner):
    """encrypted_description may be NULL."""
    mapset = Mapset(
        id=uuid4(),
        encrypted_title="encrypted:title",
        encrypted_description=None,
        encrypted_song_length_ms="encrypted:100000",
        passphrase_salt="salt",
        encrypted_verification="encrypted:verified",
        owner_id=mapset_owner.id,
    )
    db_session.add(mapset)
    await db_session.commit()
    await db_session.refresh(mapset)

    result = await db_session.execute(
        select(Mapset).where(Mapset.id == mapset.id)
    )
    fetched = result.scalar_one()
    assert fetched.encrypted_description is None


@pytest.mark.asyncio
async def test_mapset_fk_violation_for_nonexistent_owner(db_session):
    """Referencing a non-existent owner_id raises IntegrityError."""
    mapset = Mapset(
        id=uuid4(),
        encrypted_title="encrypted:title",
        encrypted_song_length_ms="encrypted:100000",
        passphrase_salt="salt",
        encrypted_verification="encrypted:verified",
        owner_id=-1,  # does not exist
    )
    db_session.add(mapset)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()
