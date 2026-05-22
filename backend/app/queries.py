"""Shared DB query helpers used across multiple routers."""

from datetime import datetime, timedelta
from enum import Enum
from uuid import UUID

from sqlalchemy import and_, func, literal, not_, select
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
# Each mapset consumes max(its active difficulty count, 1) slots — an empty
# mapset still takes one slot to prevent quota abuse via many empty mapsets.
# Difficulties pending deletion (delete_at IS NOT NULL) do not consume active
# slots — they're counted against the pending-deletion buffer instead.
# func.greatest is Postgres-specific; this project requires Postgres.
MAX_DIFFICULTY_SLOTS_PER_OWNER = 50

# Per-owner cap on items sitting in pending-deletion limbo. Prevents a single
# user from filling the table with soft-deleted rows that will hold disk space
# for the full grace window.
MAX_PENDING_DELETION_SLOTS_PER_OWNER = 50

# Days a soft-deleted difficulty lingers before hard deletion.
DIFFICULTY_DELETION_GRACE_DAYS = 7


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
    """Return the total active difficulty slots consumed by ``owner_id``.

    Sums max(active_diff_count, 1) across every active (non-pending-deletion)
    mapset owned by the user. Mapsets and difficulties with ``delete_at IS NOT
    NULL`` are both excluded — scheduling deletion frees the active slot
    immediately. ``func.sum`` over no rows returns None; ``or 0`` converts that
    to int.
    """
    diff_per_mapset = (
        select(func.greatest(func.count(Difficulty.id), literal(1)).label("q"))
        .select_from(Mapset)
        .outerjoin(
            Difficulty,
            and_(
                Difficulty.mapset_id == Mapset.id,
                Difficulty.delete_at.is_(None),
            ),
        )
        .where(Mapset.owner_id == owner_id, Mapset.delete_at.is_(None))
        .group_by(Mapset.id)
        .subquery()
    )
    result = await db.execute(select(func.sum(diff_per_mapset.c.q)))
    return result.scalar_one() or 0


async def count_pending_deletion_slots(db: AsyncSession, owner_id: UUID) -> int:
    """Return the pending-deletion buffer slots in use by ``owner_id``.

    Slot cost:
      - Each difficulty with ``delete_at IS NOT NULL`` in any owned mapset = 1.
      - Each mapset with ``delete_at IS NOT NULL`` and zero active difficulties = 1.
        (An empty mapset in pending deletion still occupies one slot — otherwise
        scheduling deletion of an empty mapset would be "free" from the buffer
        perspective and let a user park unlimited empty mapsets in limbo.)
    """
    diff_count_result = await db.execute(
        select(func.count(Difficulty.id))
        .select_from(Difficulty)
        .join(Mapset, Difficulty.mapset_id == Mapset.id)
        .where(
            Mapset.owner_id == owner_id,
            Difficulty.delete_at.is_not(None),
        )
    )
    diff_count = diff_count_result.scalar_one()

    # A mapset has an "active difficulty" iff it has any Difficulty row with
    # delete_at IS NULL. Use NOT EXISTS so an empty mapset (no diffs at all)
    # also matches "zero active difficulties".
    has_active_diff = (
        select(literal(1))
        .select_from(Difficulty)
        .where(
            Difficulty.mapset_id == Mapset.id,
            Difficulty.delete_at.is_(None),
        )
        .exists()
    )
    empty_pending_result = await db.execute(
        select(func.count(Mapset.id)).where(
            Mapset.owner_id == owner_id,
            Mapset.delete_at.is_not(None),
            not_(has_active_diff),
        )
    )
    empty_pending = empty_pending_result.scalar_one()

    return diff_count + empty_pending
