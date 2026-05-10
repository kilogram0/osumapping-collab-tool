"""Mapset router. Only ``POST /mapsets`` is implemented so far; list / read /
update / delete handlers land in later phase-2 steps."""

from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_csrf_protection
from app.models import Mapset, MapsetMember, MapsetRole, User
from app.schemas import MapsetCreate, MapsetRead

router = APIRouter(prefix="/mapsets", tags=["mapsets"])


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
) -> Mapset:
    """Create a new encrypted mapset and add the creator as ``owner``.

    The backend stores all encrypted fields verbatim. The creator is
    automatically inserted into ``MapsetMember`` with role ``owner`` in
    the same transaction.
    """
    mapset = Mapset(
        id=payload.id,
        encrypted_title=payload.encrypted_title,
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
    return mapset
