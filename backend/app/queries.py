"""Shared DB query helpers used across multiple routers."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import MapsetMember


async def get_mapset_membership(
    db: AsyncSession, mapset_id: UUID, user_id: UUID
) -> MapsetMember | None:
    """Return the MapsetMember row for (mapset_id, user_id), or None."""
    return (
        await db.execute(
            select(MapsetMember).where(
                MapsetMember.mapset_id == mapset_id,
                MapsetMember.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
