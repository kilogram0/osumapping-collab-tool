"""Difficulty router — full CRUD for encrypted difficulties.

All content fields are opaque ciphertext; the backend stores and returns them
verbatim.  Every route is member-gated: non-members and insufficiently-
privileged members both receive ``403``.
"""

from datetime import datetime, timedelta, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, update as sa_update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.dependencies import get_current_user, require_csrf_protection
from app.models import Difficulty, Mapset, MapsetRole, User
from app.queries import (
    DIFFICULTY_DELETION_GRACE_DAYS,
    MAX_DIFFICULTY_SLOTS_PER_OWNER,
    MAX_PENDING_DELETION_SLOTS_PER_OWNER,
    MembershipKind,
    classify_membership,
    count_pending_deletion_slots,
    get_mapset_membership,
    get_owner_quota_used,
)
from app.schemas import (
    DifficultyCreate,
    DifficultyDetailRead,
    DifficultyRead,
    DifficultyUpdate,
)

router = APIRouter(tags=["difficulties"])


def _forbidden() -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


@router.post(
    "/mapsets/{mapset_id}/difficulties",
    response_model=DifficultyRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf_protection)],
)
async def create_difficulty(
    mapset_id: UUID,
    payload: DifficultyCreate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Difficulty:
    """Create a difficulty inside a mapset.

    Permitted for ``owner`` and ``mapper`` roles. Note the asymmetry: mappers
    can create a difficulty, but renaming/deleting it and adding sections to
    it are owner-only — a mapper contributes a guest difficulty whose
    structure the owner curates.
    """
    mapset = await db.get(Mapset, mapset_id)
    if mapset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mapset not found")

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if (
        classify_membership(membership) != MembershipKind.ACTIVE
        or membership.role not in (MapsetRole.owner, MapsetRole.mapper)  # type: ignore[union-attr]
    ):
        raise _forbidden()

    # Quota check: adding the first active diff to a mapset costs 0 extra slots
    # (the mapset already counted as 1 when empty); any subsequent active diff
    # costs 1. Only active (delete_at IS NULL) diffs count — pending-deletion
    # rows have already vacated their active slot.
    # Known TOCTOU: two concurrent POSTs at quota = limit - 1 can both pass.
    # Acceptable for the current single-UI use case; add SELECT FOR UPDATE if
    # scripted abuse becomes a concern.
    existing_in_mapset_result = await db.execute(
        select(func.count(Difficulty.id)).where(
            Difficulty.mapset_id == mapset_id,
            Difficulty.delete_at.is_(None),
        )
    )
    existing_in_mapset = existing_in_mapset_result.scalar_one()
    quota_increase = 0 if existing_in_mapset == 0 else 1
    current_quota = await get_owner_quota_used(db, mapset.owner_id)
    if current_quota + quota_increase > MAX_DIFFICULTY_SLOTS_PER_OWNER:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Difficulty limit reached",
        )

    difficulty = Difficulty(
        id=payload.id,
        mapset_id=mapset_id,
        encrypted_name=payload.encrypted_name,
    )
    db.add(difficulty)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Conflict creating difficulty",
        ) from exc
    await db.refresh(difficulty)
    return difficulty


@router.get(
    "/mapsets/{mapset_id}/difficulties",
    response_model=list[DifficultyRead],
)
async def list_difficulties(
    mapset_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    include_pending: bool = False,
) -> list[Difficulty]:
    """List difficulties in a mapset.

    By default returns only active (non-pending-deletion) difficulties. Pass
    ``?include_pending=true`` (owner only) to include rows scheduled for purge
    so the UI can render the "Show deleted difficulties" view. Ghost members
    are never granted ``include_pending`` — they see only active rows that
    existed at their kick time.
    """
    mapset = await db.get(Mapset, mapset_id)
    if mapset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mapset not found")

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    kind = classify_membership(membership)
    if kind == MembershipKind.NONE:
        raise _forbidden()

    show_pending = (
        include_pending
        and kind == MembershipKind.ACTIVE
        and membership.role == MapsetRole.owner  # type: ignore[union-attr]
    )

    query = select(Difficulty).where(Difficulty.mapset_id == mapset_id)
    if not show_pending:
        query = query.where(Difficulty.delete_at.is_(None))
    if kind == MembershipKind.GHOST:
        # Ghost members see only difficulties that existed at kick time.
        query = query.where(Difficulty.created_at <= membership.kicked_at)  # type: ignore[union-attr]
    result = await db.execute(query)
    return list(result.scalars().all())


@router.get("/difficulties/{difficulty_id}", response_model=DifficultyDetailRead)
async def get_difficulty(
    difficulty_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Difficulty:
    """Return a single difficulty with all its sections and posts.

    Returns ``403`` if the current user is not a member of the parent mapset,
    and ``404`` if the difficulty does not exist.

    Posts are ordered chronologically by ``created_at`` ascending.
    """
    result = await db.execute(
        select(Difficulty)
        .where(Difficulty.id == difficulty_id)
        .options(
            selectinload(Difficulty.sections),
            selectinload(Difficulty.posts),
        )
    )
    difficulty = result.scalar_one_or_none()
    if difficulty is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Difficulty not found")

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    kind = classify_membership(membership)
    if kind == MembershipKind.NONE:
        raise _forbidden()

    if kind == MembershipKind.GHOST:
        kicked_at = membership.kicked_at  # type: ignore[union-attr]
        if difficulty.created_at > kicked_at or difficulty.delete_at is not None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Difficulty not found")
        # Explicit dict (not ORM mutation) keeps the filter from being
        # inadvertently flushed and prevents newly-added response fields from
        # silently bypassing the ghost cutoff.
        return DifficultyDetailRead.model_validate({
            "id": difficulty.id,
            "mapset_id": difficulty.mapset_id,
            "encrypted_name": difficulty.encrypted_name,
            "created_at": difficulty.created_at,
            "updated_at": difficulty.updated_at,
            "delete_at": difficulty.delete_at,
            "sections": [s for s in difficulty.sections if s.created_at <= kicked_at],
            "posts": [p for p in difficulty.posts if p.created_at <= kicked_at],
        })

    # Pending-deletion rows are invisible to all non-owner active members,
    # mirroring the default behaviour of list_difficulties.
    is_active_owner = (
        kind == MembershipKind.ACTIVE
        and membership.role == MapsetRole.owner  # type: ignore[union-attr]
    )
    if difficulty.delete_at is not None and not is_active_owner:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Difficulty not found")

    return difficulty


@router.patch(
    "/difficulties/{difficulty_id}",
    response_model=DifficultyRead,
    dependencies=[Depends(require_csrf_protection)],
)
async def update_difficulty(
    difficulty_id: UUID,
    payload: DifficultyUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Difficulty:
    """Partially update a difficulty (PATCH semantics).

    Permitted for ``owner`` role only.
    """
    difficulty = await db.get(Difficulty, difficulty_id)
    if difficulty is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Difficulty not found")

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    if (
        classify_membership(membership) != MembershipKind.ACTIVE
        or membership.role != MapsetRole.owner  # type: ignore[union-attr]
    ):
        raise _forbidden()

    if "encrypted_name" in payload.model_fields_set:
        difficulty.encrypted_name = payload.encrypted_name

    await db.commit()
    await db.refresh(difficulty)
    return difficulty


@router.delete(
    "/difficulties/{difficulty_id}",
    response_model=DifficultyRead,
    dependencies=[Depends(require_csrf_protection)],
)
async def delete_difficulty(
    difficulty_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Difficulty:
    """Schedule a difficulty for deletion after a 7-day grace period.

    Permitted for ``owner`` role only. The row stays in the DB with
    ``delete_at`` set; a background task purges it after the grace window.
    The owner can restore it via ``POST /difficulties/{id}/restore`` until
    then. Subject to the per-owner pending-deletion buffer.
    """
    difficulty = await db.get(Difficulty, difficulty_id)
    if difficulty is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Difficulty not found")

    mapset = await db.get(Mapset, difficulty.mapset_id)
    if mapset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mapset not found")

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    if (
        classify_membership(membership) != MembershipKind.ACTIVE
        or membership.role != MapsetRole.owner  # type: ignore[union-attr]
    ):
        raise _forbidden()

    if difficulty.delete_at is not None:
        # Already pending — return the current row idempotently.
        return difficulty

    pending_used = await count_pending_deletion_slots(db, mapset.owner_id)
    if pending_used >= MAX_PENDING_DELETION_SLOTS_PER_OWNER:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Pending-deletion limit reached ({MAX_PENDING_DELETION_SLOTS_PER_OWNER} slots). "
                "Wait for scheduled purges or restore a difficulty."
            ),
        )

    # Use SA Core UPDATE to avoid bumping updated_at — this is a lifecycle
    # transition, not a content edit.
    new_delete_at = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(
        days=DIFFICULTY_DELETION_GRACE_DAYS
    )
    await db.execute(
        sa_update(Difficulty)
        .where(Difficulty.id == difficulty_id)
        .values(delete_at=new_delete_at)
    )
    await db.commit()
    await db.refresh(difficulty)
    return difficulty


@router.post(
    "/difficulties/{difficulty_id}/restore",
    response_model=DifficultyRead,
    dependencies=[Depends(require_csrf_protection)],
)
async def restore_difficulty(
    difficulty_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Difficulty:
    """Cancel a pending deletion, returning the difficulty to the active pool.

    Permitted for ``owner`` role only. Subject to the active difficulty quota:
    if restoring would push the owner over ``MAX_DIFFICULTY_SLOTS_PER_OWNER``,
    the request is rejected with 409 and the row stays in pending state.
    """
    difficulty = await db.get(Difficulty, difficulty_id)
    if difficulty is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Difficulty not found")

    mapset = await db.get(Mapset, difficulty.mapset_id)
    if mapset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mapset not found")

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    if (
        classify_membership(membership) != MembershipKind.ACTIVE
        or membership.role != MapsetRole.owner  # type: ignore[union-attr]
    ):
        raise _forbidden()

    if difficulty.delete_at is None:
        # Already active — idempotent.
        return difficulty

    # If the mapset currently has zero active difficulties, restoring this one
    # does not add a new slot — the mapset was already counted as 1 in the
    # active quota. Otherwise, restoring adds 1.
    active_count_result = await db.execute(
        select(func.count(Difficulty.id)).where(
            Difficulty.mapset_id == difficulty.mapset_id,
            Difficulty.delete_at.is_(None),
        )
    )
    quota_increase = 0 if active_count_result.scalar_one() == 0 else 1
    current_quota = await get_owner_quota_used(db, mapset.owner_id)
    if current_quota + quota_increase > MAX_DIFFICULTY_SLOTS_PER_OWNER:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Active difficulty limit reached ({MAX_DIFFICULTY_SLOTS_PER_OWNER} slots). "
                "Cannot restore until you delete other difficulties."
            ),
        )

    # Use SA Core UPDATE to avoid bumping updated_at (lifecycle, not content edit).
    await db.execute(
        sa_update(Difficulty)
        .where(Difficulty.id == difficulty_id)
        .values(delete_at=None)
    )
    await db.commit()
    await db.refresh(difficulty)
    return difficulty
