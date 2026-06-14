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
    DifficultyBaseOsuVersion,
    Mapset,
    MapsetRole,
    Section,
    SectionOsuVersion,
    User,
)
from app.queries import (
    ROW_OVERHEAD_BYTES,
    MembershipKind,
    assert_active_capacity,
    classify_membership,
    forbidden,
    get_difficulty_or_404,
    get_mapset_membership,
    get_section_or_404,
    require_active,
    require_role,
)
from app.schemas import (
    BaseOsuCreate,
    BaseOsuRead,
    BaseOsuVersionListItem,
    SectionAssign,
    SectionCreate,
    SectionOsuRead,
    SectionOsuUpload,
    SectionOsuVersionListItem,
    SectionRead,
    SectionUpdate,
)

router = APIRouter(tags=["sections"])


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

    Permitted for ``owner`` role only.
    """
    difficulty = await get_difficulty_or_404(db, difficulty_id)

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    require_role(membership, MapsetRole.owner)

    mapset = await db.get(Mapset, difficulty.mapset_id)
    await assert_active_capacity(db, mapset.owner_id, ROW_OVERHEAD_BYTES)  # type: ignore[union-attr]

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
    difficulty = await get_difficulty_or_404(db, difficulty_id)

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    kind = classify_membership(membership)
    if kind == MembershipKind.NONE:
        raise forbidden()

    query = select(Section).where(Section.difficulty_id == difficulty_id)
    if kind == MembershipKind.GHOST:
        query = query.where(Section.created_at <= membership.kicked_at)  # type: ignore[union-attr]
    result = await db.execute(query)
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
    section, mapset_id = await get_section_or_404(db, difficulty_id, section_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    kind = classify_membership(membership)
    if kind == MembershipKind.NONE:
        raise forbidden()

    if kind == MembershipKind.GHOST and section.created_at > membership.kicked_at:  # type: ignore[operator]
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Section not found")

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
    section, mapset_id = await get_section_or_404(db, difficulty_id, section_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    require_role(membership, MapsetRole.owner, MapsetRole.mapper)

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
    section, mapset_id = await get_section_or_404(db, difficulty_id, section_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    require_role(membership, MapsetRole.owner)

    await db.execute(sa_delete(Section).where(Section.id == section_id))
    await db.commit()
    return None


# ---------------------------------------------------------------------------
# Section assignment
# ---------------------------------------------------------------------------


@router.patch(
    "/difficulties/{difficulty_id}/sections/{section_id}/assign",
    response_model=SectionRead,
    dependencies=[Depends(require_csrf_protection)],
)
async def assign_section(
    difficulty_id: UUID,
    section_id: UUID,
    payload: SectionAssign,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Section:
    """Assign or unassign a section to a mapset member.

    **Owner** can assign to any active member, or clear the assignment
    (``user_id: null``).

    **Mapper** can only claim an unassigned section for themselves
    (``user_id`` must equal their own user id; section must have no current
    assignee).  Mappers cannot reassign or clear any assignment — including
    one they set themselves.  Only the owner can release a claim.

    **Modder** and ghost members are forbidden.
    """
    section, mapset_id = await get_section_or_404(db, difficulty_id, section_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    membership = require_active(membership)

    if membership.role == MapsetRole.owner:
        # Owner can assign to any active member or clear. Modders cannot be
        # assigned a section because they are not permitted to upload .osu
        # files — a modder-assigned section would be a dead end.
        if payload.user_id is not None:
            target_membership = await get_mapset_membership(db, mapset_id, payload.user_id)
            if (
                target_membership is None
                or classify_membership(target_membership) != MembershipKind.ACTIVE
            ):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Target user is not an active member of this mapset",
                )
            if target_membership.role == MapsetRole.modder:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Modders cannot be assigned sections",
                )
        section.assigned_to = payload.user_id
    elif membership.role == MapsetRole.mapper:
        # Mapper can only claim an unassigned section for themselves.
        if payload.user_id != current_user.id:
            raise forbidden()
        # Atomic claim: eliminates the read-check-write race between concurrent
        # mappers who both read assigned_to=None before either commits.
        result = await db.execute(
            sa_update(Section)
            .where(Section.id == section_id, Section.assigned_to.is_(None))
            .values(assigned_to=current_user.id)
            .execution_options(synchronize_session=False)
        )
        if result.rowcount == 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Section is already assigned to another member",
            )
        await db.commit()
        await db.refresh(section)
        return section
    else:
        raise forbidden()

    await db.commit()
    await db.refresh(section)
    return section


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
    _, mapset_id = await get_section_or_404(db, difficulty_id, section_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    membership = require_role(membership, MapsetRole.owner, MapsetRole.mapper)

    # Only the owner may create a new base version (either as part of the
    # first-base seed or by promoting a section .osu later).  This mirrors
    # the frontend role policy and prevents a mapper from bypassing the UI
    # gate by crafting a request with `base_version` set.
    if payload.base_version is not None and membership.role != MapsetRole.owner:
        raise forbidden()

    # Active-storage check: this upload adds one version row (+ optionally one
    # base-version row), each costing its content plus a fixed row overhead.
    incoming = ROW_OVERHEAD_BYTES + len(payload.encrypted_content)
    if payload.base_version is not None:
        incoming += ROW_OVERHEAD_BYTES + len(payload.base_version.encrypted_content)
    mapset = await db.get(Mapset, mapset_id)
    await assert_active_capacity(db, mapset.owner_id, incoming)  # type: ignore[union-attr]

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
            byte_size=len(payload.encrypted_content),
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
                byte_size=len(payload.base_version.encrypted_content),
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
    section, mapset_id = await get_section_or_404(db, difficulty_id, section_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    kind = classify_membership(membership)
    if kind == MembershipKind.NONE:
        raise forbidden()

    # Ghost members see only the section itself (if pre-kick) and only the
    # active version that existed at kick time — not a newer activation.
    if kind == MembershipKind.GHOST and section.created_at > membership.kicked_at:  # type: ignore[operator]
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Section not found")

    query = select(SectionOsuVersion).where(
        SectionOsuVersion.section_id == section_id,
        SectionOsuVersion.is_active == True,  # noqa: E712
    )
    if kind == MembershipKind.GHOST:
        query = query.where(SectionOsuVersion.created_at <= membership.kicked_at)  # type: ignore[union-attr]
    result = await db.execute(query)
    active_version = result.scalar_one_or_none()
    if active_version is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active .osu version found",
        )

    return active_version


@router.get(
    "/difficulties/{difficulty_id}/base.osu",
    response_model=BaseOsuRead,
)
async def download_base_osu(
    difficulty_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DifficultyBaseOsuVersion:
    """Return the currently active base .osu version for a difficulty.

    Returns ``404`` if no base version has been uploaded yet.
    """
    difficulty = await get_difficulty_or_404(db, difficulty_id)

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    kind = classify_membership(membership)
    if kind == MembershipKind.NONE:
        raise forbidden()

    # Ghost members see only the base version that was active at kick time.
    if kind == MembershipKind.GHOST and difficulty.created_at > membership.kicked_at:  # type: ignore[operator]
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Difficulty not found")

    query = select(DifficultyBaseOsuVersion).where(
        DifficultyBaseOsuVersion.difficulty_id == difficulty_id,
        DifficultyBaseOsuVersion.is_active == True,  # noqa: E712
    )
    if kind == MembershipKind.GHOST:
        query = query.where(DifficultyBaseOsuVersion.created_at <= membership.kicked_at)  # type: ignore[union-attr]
    result = await db.execute(query)
    active_base = result.scalar_one_or_none()
    if active_base is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active base .osu version found",
        )

    return active_base


# ---------------------------------------------------------------------------
# Section version history
# ---------------------------------------------------------------------------


@router.get(
    "/difficulties/{difficulty_id}/sections/{section_id}/osu/versions",
    response_model=list[SectionOsuVersionListItem],
)
async def list_section_osu_versions(
    difficulty_id: UUID,
    section_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[SectionOsuVersion]:
    """List all .osu versions for a section, newest first.

    Returns ``404`` if the section does not exist or does not belong to the
    given difficulty.  Returns ``403`` if the user is not a mapset member.

    .. note::
       This endpoint is currently unbounded. For sections with many uploads
       (hundreds of versions), consider adding ``limit``/``offset``
       parameters in a future release.
    """
    _, mapset_id = await get_section_or_404(db, difficulty_id, section_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    kind = classify_membership(membership)
    if kind == MembershipKind.NONE:
        raise forbidden()

    query = (
        select(SectionOsuVersion)
        .where(SectionOsuVersion.section_id == section_id)
        .order_by(SectionOsuVersion.version.desc())
        .limit(500)
    )
    if kind == MembershipKind.GHOST:
        query = query.where(SectionOsuVersion.created_at <= membership.kicked_at)  # type: ignore[union-attr]
    result = await db.execute(query)
    return list(result.scalars().all())


@router.post(
    "/difficulties/{difficulty_id}/sections/{section_id}/osu/versions/{version_id}/activate",
    response_model=SectionOsuRead,
    dependencies=[Depends(require_csrf_protection)],
)
async def activate_section_osu_version(
    difficulty_id: UUID,
    section_id: UUID,
    version_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> SectionOsuVersion:
    """Roll back to a previous section .osu version.

    Deactivates the currently active version and activates the target version
    in a single transaction.  Permitted for ``owner`` and ``mapper`` roles
    only.  Returns ``404`` if the version does not exist or does not belong to
    the given section.  Returns ``409`` if a concurrent activation wins the
    race for the partial unique index.
    """
    _, mapset_id = await get_section_or_404(db, difficulty_id, section_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    require_role(membership, MapsetRole.owner, MapsetRole.mapper)

    # Verify the target version exists and belongs to this section.
    target = (
        await db.execute(
            select(SectionOsuVersion).where(
                SectionOsuVersion.id == version_id,
                SectionOsuVersion.section_id == section_id,
            )
        )
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Version not found",
        )

    # No-op if already active.
    if target.is_active:
        return target

    try:
        await db.execute(
            sa_update(SectionOsuVersion)
            .where(
                SectionOsuVersion.section_id == section_id,
                SectionOsuVersion.is_active == True,  # noqa: E712
            )
            .values(is_active=False)
        )
        target.is_active = True
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Concurrent activation conflict — please retry",
        ) from exc

    await db.refresh(target)
    return target


# ---------------------------------------------------------------------------
# Base version history
# ---------------------------------------------------------------------------


@router.post(
    "/difficulties/{difficulty_id}/base/versions",
    response_model=BaseOsuRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf_protection)],
)
async def create_base_osu_version(
    difficulty_id: UUID,
    payload: BaseOsuCreate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DifficultyBaseOsuVersion:
    """Create a new active base .osu version directly (not bundled with a
    section upload).

    Owner-only: only the owner may mint base versions, mirroring the bundled
    path in ``upload_section_osu`` (a mapper must not bypass that gate by
    crafting a request here).  Used to keep the base's ``[Editor]`` bookmarks
    in lock-step with the section divisions after a structural edit.
    ``source_section_version_id`` is null since no section produced it.

    Deactivates the previous active base and activates the new one in a single
    transaction.  Returns ``409`` if a concurrent write wins the race for the
    partial unique index on ``(difficulty_id, version)``.
    """
    difficulty = await get_difficulty_or_404(db, difficulty_id)

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    require_role(membership, MapsetRole.owner)

    mapset = await db.get(Mapset, difficulty.mapset_id)
    await assert_active_capacity(
        db,
        mapset.owner_id,  # type: ignore[union-attr]
        ROW_OVERHEAD_BYTES + len(payload.encrypted_content),
    )

    max_base_result = await db.execute(
        select(func.coalesce(func.max(DifficultyBaseOsuVersion.version), 0)).where(
            DifficultyBaseOsuVersion.difficulty_id == difficulty_id
        )
    )
    next_base_version = max_base_result.scalar_one() + 1

    try:
        await db.execute(
            sa_update(DifficultyBaseOsuVersion)
            .where(
                DifficultyBaseOsuVersion.difficulty_id == difficulty_id,
                DifficultyBaseOsuVersion.is_active == True,  # noqa: E712
            )
            .values(is_active=False)
        )

        new_base = DifficultyBaseOsuVersion(
            id=payload.id,
            difficulty_id=difficulty_id,
            encrypted_content=payload.encrypted_content,
            byte_size=len(payload.encrypted_content),
            version=next_base_version,
            is_active=True,
            source_section_version_id=None,
        )
        db.add(new_base)
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Concurrent base upload conflict — please retry",
        ) from exc

    await db.refresh(new_base)
    return new_base


@router.get(
    "/difficulties/{difficulty_id}/base/versions",
    response_model=list[BaseOsuVersionListItem],
)
async def list_base_osu_versions(
    difficulty_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[DifficultyBaseOsuVersion]:
    """List all base versions for a difficulty, newest first.

    Returns ``404`` if the difficulty does not exist.  Returns ``403`` if the
    user is not a mapset member.

    .. note::
       This endpoint is currently unbounded. For difficulties with many
       uploads (hundreds of versions), consider adding ``limit``/``offset``
       parameters in a future release.
    """
    difficulty = await get_difficulty_or_404(db, difficulty_id)

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    kind = classify_membership(membership)
    if kind == MembershipKind.NONE:
        raise forbidden()

    query = (
        select(DifficultyBaseOsuVersion)
        .where(DifficultyBaseOsuVersion.difficulty_id == difficulty_id)
        .order_by(DifficultyBaseOsuVersion.version.desc())
        .limit(500)
    )
    if kind == MembershipKind.GHOST:
        query = query.where(DifficultyBaseOsuVersion.created_at <= membership.kicked_at)  # type: ignore[union-attr]
    result = await db.execute(query)
    return list(result.scalars().all())


@router.post(
    "/difficulties/{difficulty_id}/base/versions/{version_id}/activate",
    response_model=BaseOsuRead,
    dependencies=[Depends(require_csrf_protection)],
)
async def activate_base_osu_version(
    difficulty_id: UUID,
    version_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DifficultyBaseOsuVersion:
    """Roll back to a previous base .osu version.

    Deactivates the currently active base and activates the target base in a
    single transaction.  Permitted for ``owner`` and ``mapper`` roles only.
    Returns ``404`` if the version does not exist or does not belong to the
    given difficulty.  Returns ``409`` if a concurrent activation wins the race
    for the partial unique index.
    """
    difficulty = await get_difficulty_or_404(db, difficulty_id)

    membership = await get_mapset_membership(db, difficulty.mapset_id, current_user.id)
    require_role(membership, MapsetRole.owner, MapsetRole.mapper)

    # Verify the target version exists and belongs to this difficulty.
    target = (
        await db.execute(
            select(DifficultyBaseOsuVersion).where(
                DifficultyBaseOsuVersion.id == version_id,
                DifficultyBaseOsuVersion.difficulty_id == difficulty_id,
            )
        )
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Version not found",
        )

    # No-op if already active.
    if target.is_active:
        return target

    try:
        await db.execute(
            sa_update(DifficultyBaseOsuVersion)
            .where(
                DifficultyBaseOsuVersion.difficulty_id == difficulty_id,
                DifficultyBaseOsuVersion.is_active == True,  # noqa: E712
            )
            .values(is_active=False)
        )
        target.is_active = True
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Concurrent activation conflict — please retry",
        ) from exc

    await db.refresh(target)
    return target
