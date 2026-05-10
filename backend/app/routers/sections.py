"""Section router — full CRUD for encrypted sections.

Sections are scoped to a difficulty: all routes include ``difficulty_id`` in
the path.  All content fields are opaque ciphertext.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_csrf_protection
from app.models import Difficulty, MapsetRole, Section, User
from app.queries import get_mapset_membership
from app.schemas import SectionCreate, SectionRead, SectionUpdate

router = APIRouter(tags=["sections"])


def _forbidden() -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


async def _get_difficulty(db: AsyncSession, difficulty_id: UUID) -> Difficulty:
    """Load a difficulty or raise 404."""
    difficulty = await db.get(Difficulty, difficulty_id)
    if difficulty is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Difficulty not found")
    return difficulty


async def _get_section(
    db: AsyncSession, difficulty_id: UUID, section_id: UUID
) -> tuple[Section, UUID]:
    """Load a section verified to belong to difficulty; return (section, mapset_id).

    A single JOIN avoids a second round-trip to fetch the difficulty just for
    its mapset_id — the parent row is already being touched to verify the path.
    """
    row = (
        await db.execute(
            select(Section, Difficulty.mapset_id)
            .join(Difficulty, Difficulty.id == Section.difficulty_id)
            .where(Section.id == section_id, Section.difficulty_id == difficulty_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Section not found")
    section, mapset_id = row
    return section, mapset_id


@router.post(
    "/difficulties/{difficulty_id}/sections",
    response_model=SectionRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf_protection)],
)
async def create_section(
    difficulty_id: UUID,
    payload: SectionCreate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Section:
    """Create a section inside a difficulty.

    Permitted for ``owner`` and ``mapper`` roles only.
    """
    difficulty = await _get_difficulty(db, difficulty_id)

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    if membership is None or membership.role not in (MapsetRole.owner, MapsetRole.mapper):
        raise _forbidden()

    section = Section(
        id=payload.id,
        difficulty_id=difficulty_id,
        encrypted_name=payload.encrypted_name,
        encrypted_start_time_ms=payload.encrypted_start_time_ms,
        encrypted_end_time_ms=payload.encrypted_end_time_ms,
        encrypted_sort_order=payload.encrypted_sort_order,
    )
    db.add(section)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Conflict creating section",
        ) from exc
    await db.refresh(section)
    return section


@router.get(
    "/difficulties/{difficulty_id}/sections",
    response_model=list[SectionRead],
)
async def list_sections(
    difficulty_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[Section]:
    """List all sections in a difficulty.

    Any member can list sections.
    """
    difficulty = await _get_difficulty(db, difficulty_id)

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    if membership is None:
        raise _forbidden()

    result = await db.execute(
        select(Section).where(Section.difficulty_id == difficulty_id)
    )
    return list(result.scalars().all())


@router.get(
    "/difficulties/{difficulty_id}/sections/{section_id}",
    response_model=SectionRead,
)
async def get_section(
    difficulty_id: UUID,
    section_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Section:
    """Return a single section.

    Returns ``404`` if the section does not exist or does not belong to the
    given difficulty.  Returns ``403`` if the user is not a mapset member.
    """
    section, mapset_id = await _get_section(db, difficulty_id, section_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if membership is None:
        raise _forbidden()

    return section


@router.patch(
    "/difficulties/{difficulty_id}/sections/{section_id}",
    response_model=SectionRead,
    dependencies=[Depends(require_csrf_protection)],
)
async def update_section(
    difficulty_id: UUID,
    section_id: UUID,
    payload: SectionUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Section:
    """Partially update a section (PATCH semantics).

    Permitted for ``owner`` and ``mapper`` roles only.
    """
    section, mapset_id = await _get_section(db, difficulty_id, section_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if membership is None or membership.role not in (MapsetRole.owner, MapsetRole.mapper):
        raise _forbidden()

    fields_set = payload.model_fields_set
    if "encrypted_name" in fields_set:
        section.encrypted_name = payload.encrypted_name
    if "encrypted_start_time_ms" in fields_set:
        section.encrypted_start_time_ms = payload.encrypted_start_time_ms
    if "encrypted_end_time_ms" in fields_set:
        section.encrypted_end_time_ms = payload.encrypted_end_time_ms
    if "encrypted_sort_order" in fields_set:
        section.encrypted_sort_order = payload.encrypted_sort_order

    await db.commit()
    await db.refresh(section)
    return section


@router.delete(
    "/difficulties/{difficulty_id}/sections/{section_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf_protection)],
)
async def delete_section(
    difficulty_id: UUID,
    section_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    """Delete a section and all related data.

    Permitted for ``owner`` role only.  Cascades to all section versions
    via DB-level ``ondelete='CASCADE'``.
    """
    section, mapset_id = await _get_section(db, difficulty_id, section_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if membership is None or membership.role != MapsetRole.owner:
        raise _forbidden()

    await db.execute(sa_delete(Section).where(Section.id == section_id))
    await db.commit()
