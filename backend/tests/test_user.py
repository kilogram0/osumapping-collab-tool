"""Tests for the User model."""

import asyncio

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models import User


@pytest.mark.asyncio
async def test_create_and_read_user(db_session):
    """A User row can be inserted and queried back."""
    user = User(
        osu_id=12345, username="testuser", avatar_url="https://a.ppy.sh/12345"
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    assert user.id is not None
    assert user.created_at is not None
    assert user.updated_at is not None

    result = await db_session.execute(select(User).where(User.osu_id == 12345))
    fetched = result.scalar_one()
    assert fetched.username == "testuser"
    assert fetched.avatar_url == "https://a.ppy.sh/12345"
    assert fetched.osu_id == 12345


@pytest.mark.asyncio
async def test_osu_id_unique_constraint(db_session):
    """Inserting two users with the same osu_id raises IntegrityError."""
    user_a = User(
        osu_id=11111, username="user_a", avatar_url="https://a.ppy.sh/11111"
    )
    db_session.add(user_a)
    await db_session.commit()

    user_b = User(
        osu_id=11111, username="user_b", avatar_url="https://a.ppy.sh/22222"
    )
    db_session.add(user_b)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_updated_at_advances_on_update(db_session):
    """Updating a user advances updated_at while created_at stays fixed."""
    user = User(
        osu_id=22222, username="original", avatar_url="https://a.ppy.sh/22222"
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    original_created_at = user.created_at
    original_updated_at = user.updated_at
    assert original_created_at is not None
    assert original_updated_at is not None

    # Brief sleep so clock_timestamp() advances (microsecond resolution)
    await asyncio.sleep(0.01)

    user.username = "updated"
    await db_session.commit()
    await db_session.refresh(user)

    assert user.created_at == original_created_at
    assert user.updated_at > original_updated_at
