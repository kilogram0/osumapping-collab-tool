"""Shared DB query helpers used across multiple routers."""

from datetime import datetime, timedelta, timezone
from enum import Enum
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import case, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Difficulty,
    DifficultyBaseOsuVersion,
    DifficultyPin,
    Mapset,
    MapsetMember,
    MapsetResource,
    MapsetRole,
    Post,
    Section,
    SectionOsuVersion,
)


GHOST_GRACE_DAYS = 7

# Days a soft-deleted difficulty lingers before hard deletion.
DIFFICULTY_DELETION_GRACE_DAYS = 7


def utc_now_naive() -> datetime:
    """Return the current UTC time as a timezone-naive datetime.

    All database datetime columns store naive UTC values. Centralising this
    construction removes the risk of drift between ``datetime.utcnow()`` and
    ``datetime.now(timezone.utc).replace(tzinfo=None)`` on security boundaries.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


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
    if member.kicked_at + timedelta(days=GHOST_GRACE_DAYS) > utc_now_naive():
        return MembershipKind.GHOST
    # Row exists but grace period has expired — treat as no membership until purged.
    return MembershipKind.NONE


def forbidden() -> HTTPException:
    """Standard 403 Forbidden response used by all routers."""
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def require_active(member: MapsetMember | None) -> MapsetMember:
    """Require an active mapset membership and return the narrowed member."""
    if member is None or classify_membership(member) != MembershipKind.ACTIVE:
        raise forbidden()
    return member


def require_role(member: MapsetMember | None, *roles: MapsetRole) -> MapsetMember:
    """Require an active membership whose role is one of *roles."""
    if member is None or classify_membership(member) != MembershipKind.ACTIVE:
        raise forbidden()
    if member.role not in roles:
        raise forbidden()
    return member


async def get_mapset_or_404(db: AsyncSession, mapset_id: UUID) -> Mapset:
    """Load a mapset or raise 404."""
    mapset = await db.get(Mapset, mapset_id)
    if mapset is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Mapset not found"
        )
    return mapset


async def get_difficulty_or_404(db: AsyncSession, difficulty_id: UUID) -> Difficulty:
    """Load a difficulty or raise 404."""
    difficulty = await db.get(Difficulty, difficulty_id)
    if difficulty is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Difficulty not found"
        )
    return difficulty


async def get_section_or_404(
    db: AsyncSession, difficulty_id: UUID, section_id: UUID
) -> tuple[Section, UUID, UUID]:
    """Load a section verified to belong to difficulty.

    Returns ``(section, mapset_id, owner_id)``.  Joining through ``Difficulty``
    to ``Mapset`` in one query avoids separate round-trips to fetch the parent
    row(s) just for their IDs, which matters on the upload/update hot paths.
    """
    row = (
        await db.execute(
            select(Section, Difficulty.mapset_id, Mapset.owner_id)
            .join(Difficulty, Difficulty.id == Section.difficulty_id)
            .join(Mapset, Mapset.id == Difficulty.mapset_id)
            .where(Section.id == section_id, Section.difficulty_id == difficulty_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Section not found"
        )
    section, mapset_id, owner_id = row
    return section, mapset_id, owner_id


async def get_post_or_404(
    db: AsyncSession, difficulty_id: UUID, post_id: UUID
) -> tuple[Post, UUID, UUID]:
    """Load a post verified to belong to difficulty.

    Returns ``(post, mapset_id, owner_id)`` — see :func:`get_section_or_404`.
    """
    row = (
        await db.execute(
            select(Post, Difficulty.mapset_id, Mapset.owner_id)
            .join(Difficulty, Difficulty.id == Post.difficulty_id)
            .join(Mapset, Mapset.id == Difficulty.mapset_id)
            .where(Post.id == post_id, Post.difficulty_id == difficulty_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Post not found"
        )
    post, mapset_id, owner_id = row
    return post, mapset_id, owner_id


# ---------------------------------------------------------------------------
# Storage accounting
# ---------------------------------------------------------------------------
#
# Storage is billed to the *mapset owner* (consistent with how membership and
# the project itself are owned). Rather than maintaining a stored counter — which
# would drift, because the hard-delete purge is a bulk cascade DELETE with no
# per-row application hook — usage is *derived* on demand by summing the actual
# rows that physically exist. Deletion (soft or hard) therefore needs no special
# accounting: when the purge removes rows, the sum drops automatically.
#
# Every row carries a fixed ROW_OVERHEAD_BYTES to account for the DB space a row
# occupies even when its content is tiny (this is what bounds empty-row spam now
# that the old difficulty-slot quota is gone). Content rows add their measured
# byte_size on top. Each mapset has a MAPSET_STORAGE_FLOOR_BYTES floor so that
# parking many near-empty mapsets still costs real quota.
#
# Counted: every row of difficulty, section, section version, base version, pin,
# and post (1 KiB overhead + content where applicable), plus mapset-level
# content not tied to a difficulty — the encrypted description and resources.
# Everything is billed to the mapset owner even though any member may author
# posts — collaboration storage is the host's cost. Large blobs (versions,
# pins, posts) store a byte_size at write time so the hot path never detoasts
# them; small mapset-level fields (description, resource name/url/icon) are
# measured on demand with length() since a column wouldn't earn its keep.
#
# Two buckets, each capped independently:
#   * active  — content under a live mapset AND a live difficulty.
#   * pending — content in the 7-day soft-delete grace window (under a
#               soft-deleted difficulty or a soft-deleted mapset). It still
#               occupies disk until the purge, so it is counted and capped to
#               stop "rotate 500 mapsets through the trash" abuse.

# Bytes charged per row (difficulty, section, section version, base version,
# pin, post) to reflect the DB space a row takes regardless of content size.
ROW_OVERHEAD_BYTES = 1024

# Minimum bytes a single mapset contributes — discourages spawning many empty
# mapsets. 50 MiB / 100 KiB = 512 mapsets before the floor alone fills the cap.
MAPSET_STORAGE_FLOOR_BYTES = 100 * 1024

# Active storage cap per owner.
STORAGE_LIMIT_BYTES = 50 * 1024 * 1024

# Soft-deletion (grace-window) storage buffer per owner. 1:1 with the active cap.
PENDING_STORAGE_LIMIT_BYTES = 50 * 1024 * 1024


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


def _difficulty_cost_expr():
    """A correlated scalar SQL expression for a single difficulty's byte cost.

    Returns ``ROW_OVERHEAD`` for the difficulty row itself, plus the overhead +
    measured byte_size of every child row (sections, section versions, base
    versions, pins). Correlated scalar subqueries (one value each) are used
    deliberately to avoid the row-fan-out a multi-table JOIN would cause. Yields
    ``0`` for a NULL difficulty (an empty mapset surfaced via outer join).
    """
    overhead = ROW_OVERHEAD_BYTES
    secver = (
        select(
            func.coalesce(func.sum(SectionOsuVersion.byte_size), 0)
            + func.count(SectionOsuVersion.id) * overhead
        )
        .select_from(SectionOsuVersion)
        .join(Section, Section.id == SectionOsuVersion.section_id)
        .where(Section.difficulty_id == Difficulty.id)
        .correlate(Difficulty)
        .scalar_subquery()
    )
    base = (
        select(
            func.coalesce(func.sum(DifficultyBaseOsuVersion.byte_size), 0)
            + func.count(DifficultyBaseOsuVersion.id) * overhead
        )
        .where(DifficultyBaseOsuVersion.difficulty_id == Difficulty.id)
        .correlate(Difficulty)
        .scalar_subquery()
    )
    pin = (
        select(
            func.coalesce(func.sum(DifficultyPin.byte_size), 0)
            + func.count(DifficultyPin.id) * overhead
        )
        .where(DifficultyPin.difficulty_id == Difficulty.id)
        .correlate(Difficulty)
        .scalar_subquery()
    )
    post = (
        select(
            func.coalesce(func.sum(Post.byte_size), 0)
            + func.count(Post.id) * overhead
        )
        .where(Post.difficulty_id == Difficulty.id)
        .correlate(Difficulty)
        .scalar_subquery()
    )
    sec = (
        select(func.count(Section.id) * overhead)
        .where(Section.difficulty_id == Difficulty.id)
        .correlate(Difficulty)
        .scalar_subquery()
    )
    return case(
        (Difficulty.id.is_(None), literal(0)),
        else_=literal(overhead) + sec + secver + base + pin + post,
    )


def _mapset_extra_expr():
    """Correlated scalar SQL expression for a mapset's *own* byte cost.

    This is the mapset-level content that isn't attached to any difficulty: the
    encrypted description plus its resources (each a row overhead + name/url/icon
    length). Computed on demand via ``length()`` rather than a stored byte_size
    column — these fields are small and capped (≤20 resources/mapset, ≤32 KiB
    description), so detoasting them is cheap and a column would not earn its
    keep the way it does for the MB-scale version/pin blobs. Correlated to the
    outer ``Mapset``.
    """
    overhead = ROW_OVERHEAD_BYTES
    resources = (
        select(
            func.coalesce(
                func.sum(
                    func.length(MapsetResource.encrypted_name)
                    + func.length(MapsetResource.encrypted_url)
                    + func.coalesce(func.length(MapsetResource.encrypted_icon), 0)
                ),
                0,
            )
            + func.count(MapsetResource.id) * overhead
        )
        .where(MapsetResource.mapset_id == Mapset.id)
        .correlate(Mapset)
        .scalar_subquery()
    )
    return func.coalesce(func.length(Mapset.encrypted_description), 0) + resources


async def get_owner_storage(db: AsyncSession, owner_id: UUID) -> tuple[int, int]:
    """Return ``(active_bytes, pending_bytes)`` for an owner.

    A single query yields one row per (mapset, difficulty) — including a row for
    every empty mapset via the outer join — with that difficulty's cost. The
    per-mapset floor and the active/pending split are then applied in Python:

      * live mapset + live difficulty   -> active (floored per mapset)
      * live mapset + deleted difficulty -> pending (no floor; the diff's own
        row overhead already gives it a nonzero minimum)
      * deleted mapset (any difficulty)  -> pending (floored per mapset)

    Performance: this runs on every content mutation (notably the
    ``upload_section_osu`` hot path), so it is heavier than the COUNT it
    replaced — byte accounting inherently has to aggregate the content tables.
    The correlated scalar subqueries are a deliberate choice over a global
    pre-aggregated GROUP BY: the outer set here is a *single* owner's
    difficulties (small), and each subquery resolves through an existing FK
    index, so the cost scales with that owner's difficulty count, not table
    size. A global GROUP BY would instead scan whole child tables to build its
    hash aggregates — worse in the common case (few diffs, large tables). A
    maintained counter was rejected because the hard-delete purge is a bulk
    cascade DELETE with no per-row hook, so any counter would drift. If an
    owner's difficulty count ever makes this hot, the escape hatch is a
    trigger-maintained counter (a DB trigger *does* fire on cascade deletes).
    """
    cost = _difficulty_cost_expr()
    extra = _mapset_extra_expr()
    rows = (
        await db.execute(
            select(
                Mapset.id,
                Mapset.delete_at,
                Difficulty.id,
                Difficulty.delete_at,
                cost,
                extra,
            )
            .select_from(Mapset)
            .outerjoin(Difficulty, Difficulty.mapset_id == Mapset.id)
            .where(Mapset.owner_id == owner_id)
        )
    ).all()

    active_presum: dict[UUID, int] = {}
    pending_loose = 0  # soft-deleted diffs sitting under still-live mapsets
    pending_deleted: dict[UUID, int] = {}  # per soft-deleted mapset
    # Mapset-level cost (description + resources). Same value on every row for a
    # given mapset (it repeats across the difficulty fan-out), so we just record
    # it once per mapset and fold it into that mapset's bucket below.
    mapset_extra: dict[UUID, int] = {}

    for m_id, m_delete_at, d_id, d_delete_at, c, e in rows:
        c = int(c or 0)
        mapset_extra[m_id] = int(e or 0)
        if m_delete_at is None:
            active_presum.setdefault(m_id, 0)  # ensure the floor applies
            if d_id is None:
                continue
            if d_delete_at is None:
                active_presum[m_id] += c
            else:
                pending_loose += c
        else:
            pending_deleted.setdefault(m_id, 0)
            if d_id is not None:
                pending_deleted[m_id] += c

    floor = MAPSET_STORAGE_FLOOR_BYTES
    # A live mapset's own extra is active; a soft-deleted mapset's extra is
    # pending. (A soft-deleted diff under a live mapset stays in pending_loose;
    # its mapset's extra rides with the still-live mapset's active bucket.)
    active = sum(
        max(v + mapset_extra.get(m, 0), floor) for m, v in active_presum.items()
    )
    pending = pending_loose + sum(
        max(v + mapset_extra.get(m, 0), floor) for m, v in pending_deleted.items()
    )
    return active, pending


async def get_difficulty_storage_cost(
    db: AsyncSession, difficulty_id: UUID
) -> int:
    """Byte cost of one difficulty (overheads + content), pre-floor.

    Used when a single difficulty crosses the active/pending boundary
    (soft-delete or restore).
    """
    overhead = ROW_OVERHEAD_BYTES
    secver = (
        await db.execute(
            select(
                func.coalesce(func.sum(SectionOsuVersion.byte_size), 0)
                + func.count(SectionOsuVersion.id) * overhead
            )
            .select_from(SectionOsuVersion)
            .join(Section, Section.id == SectionOsuVersion.section_id)
            .where(Section.difficulty_id == difficulty_id)
        )
    ).scalar_one()
    base = (
        await db.execute(
            select(
                func.coalesce(func.sum(DifficultyBaseOsuVersion.byte_size), 0)
                + func.count(DifficultyBaseOsuVersion.id) * overhead
            ).where(DifficultyBaseOsuVersion.difficulty_id == difficulty_id)
        )
    ).scalar_one()
    pin = (
        await db.execute(
            select(
                func.coalesce(func.sum(DifficultyPin.byte_size), 0)
                + func.count(DifficultyPin.id) * overhead
            ).where(DifficultyPin.difficulty_id == difficulty_id)
        )
    ).scalar_one()
    post = (
        await db.execute(
            select(
                func.coalesce(func.sum(Post.byte_size), 0)
                + func.count(Post.id) * overhead
            ).where(Post.difficulty_id == difficulty_id)
        )
    ).scalar_one()
    sec = (
        await db.execute(
            select(func.count(Section.id) * overhead).where(
                Section.difficulty_id == difficulty_id
            )
        )
    ).scalar_one()
    return int(overhead + sec + secver + base + pin + post)


async def get_mapset_storage_cost(db: AsyncSession, mapset_id: UUID) -> int:
    """Total byte cost of a whole mapset, pre-floor.

    Sums every difficulty's cost plus the mapset's own extra (description +
    resources). Used when a whole mapset crosses the active/pending boundary;
    the caller applies ``MAPSET_STORAGE_FLOOR_BYTES``.
    """
    cost = _difficulty_cost_expr()
    rows = (
        await db.execute(
            select(cost)
            .select_from(Mapset)
            .outerjoin(Difficulty, Difficulty.mapset_id == Mapset.id)
            .where(Mapset.id == mapset_id)
        )
    ).all()
    diff_total = sum(int(c or 0) for (c,) in rows)
    extra = (
        await db.execute(
            select(_mapset_extra_expr()).where(Mapset.id == mapset_id)
        )
    ).scalar_one()
    return int(diff_total + int(extra or 0))


async def assert_active_capacity(
    db: AsyncSession, owner_id: UUID, incoming_bytes: int
) -> None:
    """Raise 409 if adding ``incoming_bytes`` would exceed the active cap.

    Conservative: ``incoming_bytes`` is added on top of the current floored
    usage, so an upload may be rejected slightly early when its mapset is still
    under the per-mapset floor. This only ever errs toward refusing, never
    toward exceeding the cap.
    """
    used, _ = await get_owner_storage(db, owner_id)
    if used + incoming_bytes > STORAGE_LIMIT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Storage limit reached ({STORAGE_LIMIT_BYTES // (1024 * 1024)} MiB). "
                "Delete content to free space."
            ),
        )


async def assert_pending_capacity(
    db: AsyncSession, owner_id: UUID, incoming_bytes: int
) -> None:
    """Raise 409 if soft-deleting ``incoming_bytes`` would exceed the buffer."""
    _, pending = await get_owner_storage(db, owner_id)
    if pending + incoming_bytes > PENDING_STORAGE_LIMIT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Pending-deletion storage limit reached "
                f"({PENDING_STORAGE_LIMIT_BYTES // (1024 * 1024)} MiB). "
                "Wait for scheduled purges or restore content first."
            ),
        )
