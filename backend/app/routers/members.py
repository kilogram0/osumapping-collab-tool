"""Members router — invitation and role management for mapset members.

All member-management routes are owner-only (except GET, which any member may
call).  Ownership transfer is atomic: demoting the previous owner and
promoting the new one happen in the same transaction.
"""

from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete as sa_delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_csrf_protection
from app.models import Mapset, MapsetMember, MapsetRole, User
from app.queries import get_mapset_membership
from app.schemas import (
    MemberInviteRequest,
    MemberRoleUpdate,
    MemberWithUserRead,
)

router = APIRouter(tags=["members"])


def _forbidden() -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


async def _get_mapset_or_404(db: AsyncSession, mapset_id: UUID) -> Mapset:
    mapset = await db.get(Mapset, mapset_id)
    if mapset is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Mapset not found"
        )
    return mapset


def _build_member_with_user(member: MapsetMember, user: User) -> MemberWithUserRead:
    return MemberWithUserRead(
        id=member.id,
        mapset_id=member.mapset_id,
        user_id=member.user_id,
        role=member.role,
        created_at=member.created_at,
        updated_at=member.updated_at,
        username=user.username,
        avatar_url=user.avatar_url,
        osu_id=user.osu_id,
    )


@router.get("/mapsets/{mapset_id}/members", response_model=list[MemberWithUserRead])
async def list_members(
    mapset_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[MemberWithUserRead]:
    """List all members of a mapset with their User profile.

    Available to any member.  Returns each ``MapsetMember`` row joined with
    the corresponding ``User`` (username, avatar_url, osu_id).
    """
    await _get_mapset_or_404(db, mapset_id)

    caller_membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if caller_membership is None:
        raise _forbidden()

    rows = (
        await db.execute(
            select(MapsetMember, User)
            .join(User, User.id == MapsetMember.user_id)
            .where(MapsetMember.mapset_id == mapset_id)
        )
    ).all()

    return [_build_member_with_user(member, user) for member, user in rows]


@router.post(
    "/mapsets/{mapset_id}/members",
    response_model=MemberWithUserRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf_protection)],
)
async def invite_member(
    mapset_id: UUID,
    payload: MemberInviteRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MemberWithUserRead:
    """Add a member to a mapset by username.

    Owner-only.  The username is resolved against the local ``User`` table —
    the prospective member must have logged into the forum at least once.
    Returns ``404`` if the username is unknown, ``409`` if they are already a
    member.  New members are added with role ``modder``.
    """
    await _get_mapset_or_404(db, mapset_id)

    caller_membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if caller_membership is None or caller_membership.role != MapsetRole.owner:
        raise _forbidden()

    # osu! usernames are case-insensitive on the platform, so match likewise.
    target_user = (
        await db.execute(
            select(User).where(func.lower(User.username) == payload.username.lower())
        )
    ).scalar_one_or_none()
    if target_user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )

    new_member = MapsetMember(
        id=uuid4(),
        mapset_id=mapset_id,
        user_id=target_user.id,
        role=MapsetRole.modder,
    )
    db.add(new_member)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User is already a member",
        ) from exc
    await db.refresh(new_member)

    return _build_member_with_user(new_member, target_user)


@router.put(
    "/mapsets/{mapset_id}/members/{user_id}",
    response_model=MemberWithUserRead,
    dependencies=[Depends(require_csrf_protection)],
)
async def update_member_role(
    mapset_id: UUID,
    user_id: UUID,
    payload: MemberRoleUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MemberWithUserRead:
    """Change a member's role, with ownership-transfer semantics.

    Owner-only.

    Edge cases (per spec §4):
    - Setting a role the target already holds → ``200`` no-op.
    - Self-demotion (current owner sets their own role to non-owner) → ``409``.
      They must use the ownership-transfer path instead.
    - Setting the target to ``owner`` → atomically demotes the previous owner
      to ``mapper`` and updates ``Mapset.owner_id`` in one transaction.
    - Target not a member → ``404``.
    """
    mapset = await _get_mapset_or_404(db, mapset_id)

    caller_membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if caller_membership is None or caller_membership.role != MapsetRole.owner:
        raise _forbidden()

    target_membership = await get_mapset_membership(db, mapset_id, user_id)
    if target_membership is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Member not found"
        )

    target_user = await db.get(User, user_id)
    # target_user is guaranteed non-None because MapsetMember.user_id is a NOT NULL
    # FK with ondelete=CASCADE; the existence of target_membership implies the row.
    assert target_user is not None

    # No-op: role is already what they have
    if target_membership.role == payload.role:
        return _build_member_with_user(target_membership, target_user)

    # Self-demotion: current owner trying to demote themselves
    if user_id == current_user.id and payload.role != MapsetRole.owner:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot demote yourself; transfer ownership to another member first",
        )

    if payload.role == MapsetRole.owner:
        # Ownership transfer: demote old owner → mapper, promote target → owner,
        # update Mapset.owner_id — all in one transaction.
        caller_membership.role = MapsetRole.mapper
        target_membership.role = MapsetRole.owner
        mapset.owner_id = user_id
    else:
        target_membership.role = payload.role

    await db.commit()
    await db.refresh(target_membership)
    return _build_member_with_user(target_membership, target_user)


@router.delete(
    "/mapsets/{mapset_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf_protection)],
)
async def remove_member(
    mapset_id: UUID,
    user_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    """Remove a member from a mapset.

    Owner-only.  The owner cannot remove themselves — returns ``409``.
    The path param is ``User.id`` (not ``MapsetMember.id``).
    """
    await _get_mapset_or_404(db, mapset_id)

    caller_membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if caller_membership is None or caller_membership.role != MapsetRole.owner:
        raise _forbidden()

    if user_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot remove yourself from the mapset; transfer ownership or delete the mapset",
        )

    target_membership = await get_mapset_membership(db, mapset_id, user_id)
    if target_membership is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Member not found"
        )

    await db.execute(
        sa_delete(MapsetMember).where(MapsetMember.id == target_membership.id)
    )
    await db.commit()
    return None
