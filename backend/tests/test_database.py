import pytest
from sqlalchemy import text

from app.config import settings
from app.database import engine


@pytest.mark.skipif(
    settings.DATABASE_URL.startswith("sqlite") or not settings.DATABASE_URL,
    reason="Requires a live PostgreSQL database",
)
@pytest.mark.asyncio
async def test_database_connection():
    """Verify the async engine can reach PostgreSQL."""
    async with engine.connect() as conn:
        result = await conn.execute(text("SELECT 1"))
        assert result.scalar() == 1
