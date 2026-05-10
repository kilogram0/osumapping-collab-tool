"""Tests for the Difficulty model."""

from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.models import Difficulty


@pytest.mark.asyncio
async def test_create_and_read_difficulty(db_session, mapset_difficulty):
    assert mapset_difficulty.id is not None
    assert mapset_difficulty.created_at is not None
    assert mapset_difficulty.updated_at is not None

    result = await db_session.execute(
        select(Difficulty).where(Difficulty.id == mapset_difficulty.id)
    )
    fetched = result.scalar_one()
    assert fetched.encrypted_name == "encrypted:name"
    assert fetched.mapset_id == mapset_difficulty.mapset_id


@pytest.mark.asyncio
async def test_difficulty_requires_encrypted_name(db_session, mapset_with_owner):
    """encrypted_name is NOT NULL."""
    diff = Difficulty(id=uuid4(), mapset_id=mapset_with_owner.id)
    db_session.add(diff)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_difficulty_requires_valid_mapset_id(db_session):
    """mapset_id FK must reference an existing mapset."""
    diff = Difficulty(
        id=uuid4(),
        mapset_id=uuid4(),  # does not exist
        encrypted_name="encrypted:name",
    )
    db_session.add(diff)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_difficulty_cascades_on_mapset_delete(db_session, mapset_difficulty):
    """Deleting the parent Mapset cascades and removes Difficulty rows."""
    diff_id = mapset_difficulty.id
    mapset_id = mapset_difficulty.mapset_id

    await db_session.execute(
        text("DELETE FROM mapset WHERE id = :mid"),
        {"mid": mapset_id},
    )
    await db_session.commit()

    result = await db_session.execute(
        select(Difficulty).where(Difficulty.id == diff_id)
    )
    assert result.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_multiple_difficulties_per_mapset(db_session, mapset_with_owner):
    """A mapset can have multiple difficulties."""
    ids = []
    for name in ("encrypted:easy", "encrypted:hard"):
        diff = Difficulty(
            id=uuid4(),
            mapset_id=mapset_with_owner.id,
            encrypted_name=name,
        )
        db_session.add(diff)
        await db_session.commit()
        await db_session.refresh(diff)
        ids.append(diff.id)

    result = await db_session.execute(
        select(Difficulty).where(Difficulty.mapset_id == mapset_with_owner.id)
    )
    row_ids = {r.id for r in result.scalars().all()}
    assert set(ids) <= row_ids
