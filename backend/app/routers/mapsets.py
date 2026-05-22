"""Mapset router — full CRUD for encrypted mapsets.

All content fields are opaque ciphertext; the backend stores and returns them
verbatim.  Every mapset-specific route is member-gated: non-members and
insufficiently-privileged members both receive ``403``.
"""

from datetime import datetime, timedelta, timezone
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete as sa_delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_csrf_protection
from app.models import Difficulty, Mapset, MapsetMember, MapsetRole, User
from app.queries import GHOST_GRACE_DAYS, MembershipKind, classify_membership, get_mapset_membership
from app.schemas import KickedMapsetRead, MapsetCreate, MapsetMemberRead, MapsetRead, MapsetUpdate

router = APIRouter(prefix="/mapsets", tags=["mapsets"])

# Days a soft-deleted mapset lingers before hard deletion (separate from ghost grace).
_DELETION_GRACE_DAYS = 7


def _forbidden() -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


async def _count_difficulties(db: AsyncSession, mapset_id: UUID) -> int:
    result = await db.execute(
        select(func.count(Difficulty.id)).where(Difficulty.mapset_id == mapset_id)
    )
    return result.scalar_one()


def _to_read(mapset: Mapset, difficulty_count: int) -> MapsetRead:
    return MapsetRead(
        id=mapset.id,
        title=mapset.title,
        encrypted_description=mapset.encrypted_description,
        encrypted_song_length_ms=mapset.encrypted_song_length_ms,
        passphrase_salt=mapset.passphrase_salt,
        encrypted_verification=mapset.encrypted_verification,
        owner_id=mapset.owner_id,
        created_at=mapset.created_at,
        updated_at=mapset.updated_at,
        delete_at=mapset.delete_at,
        difficulty_count=difficulty_count,
    )


@router.post(
    "",
    response_model=MapsetRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf_protection)],
)
async def create_mapset(
    payload: MapsetCreate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MapsetRead:
    """Create a new encrypted mapset and add the creator as ``owner``.

    The backend stores all encrypted fields verbatim. The creator is
    automatically inserted into ``MapsetMember`` with role ``owner`` in
    the same transaction.
    """
    mapset = Mapset(
        id=payload.id,
        title=payload.title,
        encrypted_description=payload.encrypted_description,
        encrypted_song_length_ms=payload.encrypted_song_length_ms,
        passphrase_salt=payload.passphrase_salt,
        encrypted_verification=payload.encrypted_verification,
        owner_id=current_user.id,
    )
    membership = MapsetMember(
        id=uuid4(),
        mapset_id=payload.id,
        user_id=current_user.id,
        role=MapsetRole.owner,
    )
    db.add(mapset)
    db.add(membership)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        # In practice only the mapset PK can collide here (owner_id is the
        # authenticated user, the membership PK and (mapset_id, user_id)
        # uniqueness are both fresh). Stay generic so a future schema change
        # doesn't quietly turn an unrelated constraint into a misleading
        # "id already exists" message.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Conflict creating mapset",
        ) from exc
    await db.refresh(mapset)
    return _to_read(mapset, 0)


@router.get("", response_model=list[MapsetRead])
async def list_mapsets(
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[MapsetRead]:
    """List all mapsets where the current user is a member.

    Returns encrypted fields only; the frontend decrypts titles for display
    if the key is cached in ``sessionStorage``.
    """
    result = await db.execute(
        select(Mapset, func.count(Difficulty.id).label("difficulty_count"))
        .join(MapsetMember, MapsetMember.mapset_id == Mapset.id)
        .outerjoin(Difficulty, Difficulty.mapset_id == Mapset.id)
        .where(
            MapsetMember.user_id == current_user.id,
            MapsetMember.kicked_at.is_(None),
        )
        .group_by(Mapset.id)
    )
    return [_to_read(mapset, count) for mapset, count in result.all()]


@router.get("/kicked", response_model=list[KickedMapsetRead])
async def list_kicked_mapsets(
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[KickedMapsetRead]:
    """List mapsets where the current user has an active ghost (kicked) membership.

    Returns mapsets the user was recently removed from, including ``kicked_at``
    and a computed ``access_expires_at`` (kicked_at + 7 days).  Only active
    grace periods are returned — expired ghost rows are filtered out here
    (the background purge lags by up to one hour).
    """
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=GHOST_GRACE_DAYS)
    rows = await db.execute(
        select(Mapset, MapsetMember, func.count(Difficulty.id).label("difficulty_count"))
        .join(MapsetMember, MapsetMember.mapset_id == Mapset.id)
        .outerjoin(Difficulty, Difficulty.mapset_id == Mapset.id)
        .where(
            MapsetMember.user_id == current_user.id,
            MapsetMember.kicked_at.is_not(None),
            MapsetMember.kicked_at > cutoff,
        )
        .group_by(Mapset.id, MapsetMember.id)
    )
    results: list[KickedMapsetRead] = []
    for mapset, member, diff_count in rows.all():
        results.append(
            KickedMapsetRead(
                **_to_read(mapset, diff_count).model_dump(),
                kicked_at=member.kicked_at,
                access_expires_at=member.kicked_at + timedelta(days=GHOST_GRACE_DAYS),
            )
        )
    return results


@router.get("/{mapset_id}", response_model=MapsetRead)
async def get_mapset(
    mapset_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MapsetRead:
    """Return full mapset details for members.

    Returns ``403`` if the current user is not a member of the mapset, and
    ``404`` if the mapset does not exist.  All content fields are encrypted
    ciphertext — the backend never inspects them.
    """
    mapset = await db.get(Mapset, mapset_id)
    if mapset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mapset not found")

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if classify_membership(membership) == MembershipKind.NONE:
        raise _forbidden()

    diff_count = await _count_difficulties(db, mapset_id)
    return _to_read(mapset, diff_count)


@router.patch(
    "/{mapset_id}",
    response_model=MapsetRead,
    dependencies=[Depends(require_csrf_protection)],
)
async def update_mapset(
    mapset_id: UUID,
    payload: MapsetUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MapsetRead:
    """Partially update encrypted mapset fields (PATCH semantics).

    Permitted for ``owner`` and ``mapper`` roles only.  Only fields present in
    the JSON body are written; absent fields are left unchanged.  Sending
    ``"encrypted_description": null`` explicitly clears the description.
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

    # Use model_fields_set to distinguish "field omitted" from "field set to null".
    fields_set = payload.model_fields_set
    if "title" in fields_set:
        mapset.title = payload.title
    if "encrypted_description" in fields_set:
        mapset.encrypted_description = payload.encrypted_description
    if "encrypted_song_length_ms" in fields_set:
        mapset.encrypted_song_length_ms = payload.encrypted_song_length_ms

    await db.commit()
    await db.refresh(mapset)
    diff_count = await _count_difficulties(db, mapset_id)
    return _to_read(mapset, diff_count)


@router.delete(
    "/{mapset_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf_protection)],
)
async def delete_mapset(
    mapset_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    """Delete a mapset and all related data.

    Permitted for ``owner`` role only.  Cascades to all members, difficulties,
    sections, and posts via DB-level ``ondelete='CASCADE'``.
    """
    mapset = await db.get(Mapset, mapset_id)
    if mapset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mapset not found")

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if (
        classify_membership(membership) != MembershipKind.ACTIVE
        or membership.role != MapsetRole.owner  # type: ignore[union-attr]
    ):
        raise _forbidden()

    # Use a raw DML DELETE so the DB-level CASCADE fires directly; the ORM
    # `db.delete(mapset)` would attempt to NULL-out FKs before deleting, which
    # violates the NOT NULL constraint on MapsetMember.mapset_id.
    await db.execute(sa_delete(Mapset).where(Mapset.id == mapset_id))
    await db.commit()


@router.post(
    "/{mapset_id}/schedule-delete",
    response_model=MapsetRead,
    dependencies=[Depends(require_csrf_protection)],
)
async def schedule_mapset_deletion(
    mapset_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MapsetRead:
    """Schedule a mapset for deletion after a grace period. Owner only."""
    mapset = await db.get(Mapset, mapset_id)
    if mapset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mapset not found")

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if (
        classify_membership(membership) != MembershipKind.ACTIVE
        or membership.role != MapsetRole.owner  # type: ignore[union-attr]
    ):
        raise _forbidden()

    if mapset.delete_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Deletion already scheduled",
        )

    mapset.delete_at = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=_DELETION_GRACE_DAYS)
    await db.commit()
    await db.refresh(mapset)
    diff_count = await _count_difficulties(db, mapset_id)
    return _to_read(mapset, diff_count)


@router.delete(
    "/{mapset_id}/schedule-delete",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf_protection)],
)
async def cancel_mapset_deletion(
    mapset_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    """Cancel a scheduled deletion. Owner only."""
    mapset = await db.get(Mapset, mapset_id)
    if mapset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mapset not found")

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if (
        classify_membership(membership) != MembershipKind.ACTIVE
        or membership.role != MapsetRole.owner  # type: ignore[union-attr]
    ):
        raise _forbidden()

    mapset.delete_at = None
    await db.commit()


@router.get("/{mapset_id}/members/me", response_model=MapsetMemberRead)
async def get_my_membership(
    mapset_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MapsetMember:
    """Return the current user's membership in a mapset.

    Returns ``404`` if the mapset does not exist, ``403`` if the current user
    is not a member.  The ``role`` field lets the frontend gate UI actions
    (create/edit difficulties and sections) without fetching the full roster.
    """
    mapset = await db.get(Mapset, mapset_id)
    if mapset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mapset not found")

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if classify_membership(membership) == MembershipKind.NONE:
        raise _forbidden()

    return membership
