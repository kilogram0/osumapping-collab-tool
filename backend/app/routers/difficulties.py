"""Difficulty router — full CRUD for encrypted difficulties.

All content fields are opaque ciphertext; the backend stores and returns them
verbatim.  Every route is member-gated: non-members and insufficiently-
privileged members both receive ``403``.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_csrf_protection
from app.models import Difficulty, Mapset, MapsetRole, User
from app.queries import get_mapset_membership
from app.schemas import DifficultyCreate, DifficultyRead, DifficultyUpdate

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

    Permitted for ``owner`` and ``mapper`` roles only.
    """
    mapset = await db.get(Mapset, mapset_id)
    if mapset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mapset not found")

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if membership is None or membership.role not in (MapsetRole.owner, MapsetRole.mapper):
        raise _forbidden()

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
) -> list[Difficulty]:
    """List all difficulties in a mapset.

    Any member can list difficulties.
    """
    mapset = await db.get(Mapset, mapset_id)
    if mapset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mapset not found")

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if membership is None:
        raise _forbidden()

    result = await db.execute(
        select(Difficulty).where(Difficulty.mapset_id == mapset_id)
    )
    return list(result.scalars().all())


@router.get("/difficulties/{difficulty_id}", response_model=DifficultyRead)
async def get_difficulty(
    difficulty_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Difficulty:
    """Return a single difficulty.

    Returns ``403`` if the current user is not a member of the parent mapset,
    and ``404`` if the difficulty does not exist.
    """
    difficulty = await db.get(Difficulty, difficulty_id)
    if difficulty is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Difficulty not found")

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    if membership is None:
        raise _forbidden()

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

    Permitted for ``owner`` and ``mapper`` roles only.
    """
    difficulty = await db.get(Difficulty, difficulty_id)
    if difficulty is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Difficulty not found")

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    if membership is None or membership.role not in (MapsetRole.owner, MapsetRole.mapper):
        raise _forbidden()

    if "encrypted_name" in payload.model_fields_set:
        difficulty.encrypted_name = payload.encrypted_name

    await db.commit()
    await db.refresh(difficulty)
    return difficulty


@router.delete(
    "/difficulties/{difficulty_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf_protection)],
)
async def delete_difficulty(
    difficulty_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    """Delete a difficulty and all related data.

    Permitted for ``owner`` role only.  Cascades to all sections and versions
    via DB-level ``ondelete='CASCADE'``.
    """
    difficulty = await db.get(Difficulty, difficulty_id)
    if difficulty is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Difficulty not found")

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    if membership is None or membership.role != MapsetRole.owner:
        raise _forbidden()

    await db.execute(sa_delete(Difficulty).where(Difficulty.id == difficulty_id))
    await db.commit()
