"""Difficulty pin router — named snapshots of a difficulty's assembled .osu.

A pin stores the fully-merged .osu (base + all sections) as opaque ciphertext
at the moment of pinning. Creation/deletion is owner-only; any active or ghost
member may list and download pins. All content fields are opaque ciphertext.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from app.database import get_db
from app.dependencies import get_current_user, require_csrf_protection
from app.models import DifficultyPin, Mapset, MapsetRole, User
from app.queries import (
    ROW_OVERHEAD_BYTES,
    MembershipKind,
    assert_active_capacity,
    classify_membership,
    forbidden,
    get_difficulty_or_404,
    get_mapset_membership,
    require_role,
)
from app.schemas import (
    DifficultyPinContentRead,
    DifficultyPinCreate,
    DifficultyPinRead,
)

router = APIRouter(tags=["pins"])


@router.post(
    "/difficulties/{difficulty_id}/pins",
    response_model=DifficultyPinRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf_protection)],
)
async def create_pin(
    difficulty_id: UUID,
    payload: DifficultyPinCreate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DifficultyPin:
    """Create a pinned version of a difficulty. Permitted for ``owner`` only."""
    difficulty = await get_difficulty_or_404(db, difficulty_id)

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    require_role(membership, MapsetRole.owner)

    mapset = await db.get(Mapset, difficulty.mapset_id)
    await assert_active_capacity(
        db,
        mapset.owner_id,  # type: ignore[union-attr]
        ROW_OVERHEAD_BYTES + len(payload.encrypted_content),
    )

    pin = DifficultyPin(
        id=payload.id,
        difficulty_id=difficulty_id,
        encrypted_content=payload.encrypted_content,
        byte_size=len(payload.encrypted_content),
        encrypted_label=payload.encrypted_label,
        created_by=current_user.id,
    )
    db.add(pin)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        # Duplicate client-minted UUID — the only plausible integrity failure here.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A pin with this id already exists",
        ) from exc

    await db.refresh(pin)
    return pin


@router.get(
    "/difficulties/{difficulty_id}/pins",
    response_model=list[DifficultyPinRead],
)
async def list_pins(
    difficulty_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[DifficultyPin]:
    """List pin metadata (no content) for a difficulty. Any member may read."""
    difficulty = await get_difficulty_or_404(db, difficulty_id)

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    kind = classify_membership(membership)
    if kind == MembershipKind.NONE:
        raise forbidden()

    # defer(encrypted_content): each pin holds a full assembled .osu (~MB-scale
    # ciphertext) that DifficultyPinRead discards anyway. Deferring keeps the
    # list query from hauling every blob out of Postgres. limit(500) mirrors the
    # section/base version-list precedent so a runaway pin count can't unbound it.
    query = (
        select(DifficultyPin)
        .where(DifficultyPin.difficulty_id == difficulty_id)
        .options(defer(DifficultyPin.encrypted_content))  # type: ignore[arg-type]
        .order_by(DifficultyPin.created_at.desc())
        .limit(500)
    )
    # Ghost members only see pins that existed at kick time.
    if kind == MembershipKind.GHOST:
        query = query.where(DifficultyPin.created_at <= membership.kicked_at)  # type: ignore[union-attr]
    result = await db.execute(query)
    return list(result.scalars().all())


@router.get(
    "/difficulties/{difficulty_id}/pins/{pin_id}",
    response_model=DifficultyPinContentRead,
)
async def get_pin(
    difficulty_id: UUID,
    pin_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DifficultyPin:
    """Fetch a single pin including its assembled .osu ciphertext."""
    difficulty = await get_difficulty_or_404(db, difficulty_id)

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    kind = classify_membership(membership)
    if kind == MembershipKind.NONE:
        raise forbidden()

    pin = (
        await db.execute(
            select(DifficultyPin).where(
                DifficultyPin.id == pin_id,
                DifficultyPin.difficulty_id == difficulty_id,
            )
        )
    ).scalar_one_or_none()
    if pin is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Pin not found"
        )
    # Ghost members may not download pins created after they were kicked.
    if kind == MembershipKind.GHOST and pin.created_at > membership.kicked_at:  # type: ignore[operator]
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Pin not found"
        )

    return pin


@router.delete(
    "/difficulties/{difficulty_id}/pins/{pin_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf_protection)],
)
async def delete_pin(
    difficulty_id: UUID,
    pin_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    """Delete a pin. Permitted for ``owner`` only."""
    difficulty = await get_difficulty_or_404(db, difficulty_id)

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    require_role(membership, MapsetRole.owner)

    pin = (
        await db.execute(
            select(DifficultyPin).where(
                DifficultyPin.id == pin_id,
                DifficultyPin.difficulty_id == difficulty_id,
            )
        )
    ).scalar_one_or_none()
    if pin is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Pin not found"
        )

    await db.delete(pin)
    await db.commit()
