"""Global pytest fixtures for the backend test suite."""

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.database import engine
from app.main import app


@pytest.fixture
async def db_session():
    """Yield an async SQLAlchemy session connected to PostgreSQL.

    Uses the "join external transaction + SAVEPOINT" pattern so that
    ``await session.commit()`` inside a test only releases the SAVEPOINT
    while the outer transaction is rolled back at teardown. This guarantees
    full isolation — no rows persist between tests even when the code under
    test calls ``commit()``.
    """
    connection = await engine.connect()
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


@pytest.fixture
async def client():
    """Yield an httpx.AsyncClient mounted to the FastAPI app."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac
