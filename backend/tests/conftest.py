"""Global pytest fixtures for the backend test suite."""

import os
from typing import AsyncGenerator
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.database import get_db
from app.main import app as _app
from app.models import Difficulty, Mapset, User


def _resolve_test_database_url() -> str:
    """Return the database URL to use for tests.

    Priority:
    1. TEST_DATABASE_URL setting
    2. DATABASE_URL with a '_test' suffix appended to the database name

    Raises RuntimeError if the resolved URL does not contain '_test',
    preventing accidental connection to a non-test database.
    """
    if settings.TEST_DATABASE_URL:
        url = settings.TEST_DATABASE_URL
    else:
        # Append _test to the database name in DATABASE_URL
        # e.g. postgresql+asyncpg://user:pass@host:5432/modding
        #   -> postgresql+asyncpg://user:pass@host:5432/modding_test
        url = settings.DATABASE_URL
        if "/" in url:
            url = f"{url}_test"

    if "_test" not in url:
        raise RuntimeError(
            "Refusing to run tests against a non-test database. "
            "The test database URL must contain '_test'. "
            "Set TEST_DATABASE_URL or ensure DATABASE_URL ends with '_test'."
        )
    return url


# Dedicated async engine for the test suite
test_engine = create_async_engine(
    _resolve_test_database_url(),
    echo=False,
    future=True,
)


@pytest.fixture
async def db_session():
    """Yield an async SQLAlchemy session connected to PostgreSQL.

    Uses the "join external transaction + SAVEPOINT" pattern so that
    ``await session.commit()`` inside a test only releases the SAVEPOINT
    while the outer transaction is rolled back at teardown. This guarantees
    full isolation — no rows persist between tests even when the code under
    test calls ``commit()``.
    """
    connection = await test_engine.connect()
    transaction = await connection.begin()

    session_factory = async_sessionmaker(
        connection,
        class_=AsyncSession,
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    )
    session = session_factory()

    yield session

    await session.close()
    await transaction.rollback()
    await connection.close()


async def _override_get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield a session from the test engine for integration tests."""
    async with async_sessionmaker(
        test_engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )() as session:
        yield session


@pytest.fixture
async def client():
    """Yield an httpx.AsyncClient mounted to the FastAPI app.

    Overrides the ``get_db`` dependency so that integration tests
    use the test database rather than the application engine.
    """
    _app.dependency_overrides[get_db] = _override_get_db
    async with AsyncClient(
        transport=ASGITransport(app=_app), base_url="http://test"
    ) as ac:
        yield ac
    _app.dependency_overrides.clear()


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
        title="Test Mapset",
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


@pytest.fixture
async def mapset_difficulty(db_session, mapset_with_owner):
    """Create and return a Difficulty belonging to mapset_with_owner."""
    diff = Difficulty(
        id=uuid4(),
        mapset_id=mapset_with_owner.id,
        encrypted_name="encrypted:name",
    )
    db_session.add(diff)
    await db_session.commit()
    await db_session.refresh(diff)
    return diff
