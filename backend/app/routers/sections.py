"""Section router — full CRUD for encrypted sections.

Sections are scoped to a difficulty: all routes include ``difficulty_id`` in
the path.  All content fields are opaque ciphertext.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete as sa_delete, func, select, update as sa_update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_csrf_protection
from app.models import (
    Difficulty,
    DifficultyBaseOsuVersion,
    MapsetRole,
    Section,
    SectionOsuVersion,
    User,
)
from app.queries import get_mapset_membership
from app.schemas import (
    SectionCreate,
    SectionOsuRead,
    SectionOsuUpload,
    SectionRead,
    SectionUpdate,
)

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
    return None


# ---------------------------------------------------------------------------
# .osu file upload / download
# ---------------------------------------------------------------------------


@router.post(
    "/difficulties/{difficulty_id}/sections/{section_id}/osu",
    response_model=SectionOsuRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf_protection)],
)
async def upload_section_osu(
    difficulty_id: UUID,
    section_id: UUID,
    payload: SectionOsuUpload,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> SectionOsuVersion:
    """Upload a new .osu version for a section.

    Deactivates the previous active version (if any) and activates the new
    one in a single transaction.  If ``base_version`` is provided, the
    previous active base for this difficulty is also deactivated and the new
    base is activated.  SQLAlchemy's unit-of-work topologically orders the
    INSERTs so that ``SectionOsuVersion`` is written before
    ``DifficultyBaseOsuVersion``, satisfying the FK from
    ``source_section_version_id`` without an explicit flush.
    """
    _, mapset_id = await _get_section(db, difficulty_id, section_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if membership is None or membership.role not in (MapsetRole.owner, MapsetRole.mapper):
        raise _forbidden()

    # Compute next version number for this section.
    # Two concurrent uploads may race and compute the same next_version.
    # The partial unique index on (section_id, version) rejects the loser,
    # which we surface as a 409 below.
    max_version_result = await db.execute(
        select(func.coalesce(func.max(SectionOsuVersion.version), 0)).where(
            SectionOsuVersion.section_id == section_id
        )
    )
    next_version = max_version_result.scalar_one() + 1

    # Compute next base version number if a base is bundled.
    next_base_version: int | None = None
    if payload.base_version is not None:
        max_base_result = await db.execute(
            select(
                func.coalesce(func.max(DifficultyBaseOsuVersion.version), 0)
            ).where(DifficultyBaseOsuVersion.difficulty_id == difficulty_id)
        )
        next_base_version = max_base_result.scalar_one() + 1

    try:
        # Deactivate previous active section version.
        await db.execute(
            sa_update(SectionOsuVersion)
            .where(
                SectionOsuVersion.section_id == section_id,
                SectionOsuVersion.is_active == True,  # noqa: E712
            )
            .values(is_active=False)
        )

        new_version = SectionOsuVersion(
            id=payload.id,
            section_id=section_id,
            encrypted_content=payload.encrypted_content,
            version=next_version,
            is_active=True,
            uploaded_by=current_user.id,
        )
        db.add(new_version)

        if payload.base_version is not None:
            # Deactivate previous active base.
            await db.execute(
                sa_update(DifficultyBaseOsuVersion)
                .where(
                    DifficultyBaseOsuVersion.difficulty_id == difficulty_id,
                    DifficultyBaseOsuVersion.is_active == True,  # noqa: E712
                )
                .values(is_active=False)
            )

            new_base = DifficultyBaseOsuVersion(
                id=payload.base_version.id,
                difficulty_id=difficulty_id,
                encrypted_content=payload.base_version.encrypted_content,
                version=next_base_version,
                is_active=True,
                source_section_version_id=payload.id,
            )
            db.add(new_base)

        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Concurrent upload conflict — please retry",
        ) from exc

    await db.refresh(new_version)
    return new_version


@router.get(
    "/difficulties/{difficulty_id}/sections/{section_id}/osu",
    response_model=SectionOsuRead,
)
async def download_section_osu(
    difficulty_id: UUID,
    section_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> SectionOsuVersion:
    """Return the currently active .osu version for a section.

    Returns ``404`` if no version has been uploaded yet.
    """
    _, mapset_id = await _get_section(db, difficulty_id, section_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if membership is None:
        raise _forbidden()

    result = await db.execute(
        select(SectionOsuVersion).where(
            SectionOsuVersion.section_id == section_id,
            SectionOsuVersion.is_active == True,  # noqa: E712
        )
    )
    active_version = result.scalar_one_or_none()
    if active_version is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active .osu version found",
        )

    return active_version
