"""Shared DB query helpers used across multiple routers."""

from datetime import datetime, timedelta
from enum import Enum
from uuid import UUID

from sqlalchemy import func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Difficulty, Mapset, MapsetMember

GHOST_GRACE_DAYS = 7


class MembershipKind(Enum):
    ACTIVE = "active"
    GHOST = "ghost"   # kicked, grace period still active
    NONE = "none"


def classify_membership(member: MapsetMember | None) -> MembershipKind:
    """Classify a raw MapsetMember row into ACTIVE, GHOST, or NONE."""
    if member is None:
        return MembershipKind.NONE
    if member.kicked_at is None:
        return MembershipKind.ACTIVE
    if member.kicked_at + timedelta(days=GHOST_GRACE_DAYS) > datetime.utcnow():
        return MembershipKind.GHOST
    # Row exists but grace period has expired — treat as no membership until purged.
    return MembershipKind.NONE

# Difficulty slots a user may occupy across all their owned mapsets.
# Each mapset consumes max(its difficulty count, 1) slots — an empty mapset
# still takes one slot to prevent quota abuse via many empty mapsets.
# func.greatest is Postgres-specific; this project requires Postgres.
MAX_DIFFICULTY_SLOTS_PER_OWNER = 50


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


async def get_owner_quota_used(db: AsyncSession, owner_id: UUID) -> int:
    """Return the total difficulty slots consumed by ``owner_id``.

    Sums max(diff_count, 1) across every mapset owned by the user.
    func.sum over no rows returns None; ``or 0`` converts that to int.
    """
    diff_per_mapset = (
        select(func.greatest(func.count(Difficulty.id), literal(1)).label("q"))
        .select_from(Mapset)
        .outerjoin(Difficulty, Difficulty.mapset_id == Mapset.id)
        .where(Mapset.owner_id == owner_id)
        .group_by(Mapset.id)
        .subquery()
    )
    result = await db.execute(select(func.sum(diff_per_mapset.c.q)))
    return result.scalar_one() or 0
