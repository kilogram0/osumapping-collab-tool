import pytest
from sqlalchemy import text

from app.config import settings
from tests.conftest import test_engine


@pytest.mark.skipif(
    settings.TEST_DATABASE_URL is None
    and (settings.DATABASE_URL.startswith("sqlite") or not settings.DATABASE_URL),
    reason="Requires a live PostgreSQL database",
)
@pytest.mark.asyncio
async def test_test_database_connection():
    """Verify the test async engine can reach PostgreSQL."""
    async with test_engine.connect() as conn:
        result = await conn.execute(text("SELECT 1"))
        assert result.scalar() == 1
