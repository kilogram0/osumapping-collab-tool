"""Resources router — encrypted named links attached to a mapset.

All content fields are opaque ciphertext; the backend stores and returns them
verbatim.  Reads are member-gated (including ghost members).  Writes are
owner-only.  A soft cap of 20 resources per mapset prevents abuse; the check
is best-effort (TOCTOU between count and insert), acceptable at this scale.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_csrf_protection
from app.models import Mapset, MapsetResource, MapsetRole, User
from app.queries import MembershipKind, classify_membership, get_mapset_membership
from app.schemas import MapsetResourceCreate, MapsetResourceRead

router = APIRouter(prefix="/mapsets", tags=["resources"])

_RESOURCE_LIMIT = 20


async def require_mapset_owner(
    mapset_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    """Raise 403 if the current user is not an active owner of the mapset."""
    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if (
        classify_membership(membership) != MembershipKind.ACTIVE
        or membership.role != MapsetRole.owner  # type: ignore[union-attr]
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


@router.get("/{mapset_id}/resources", response_model=list[MapsetResourceRead])
async def list_resources(
    mapset_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[MapsetResource]:
    """List all resources for a mapset. Accessible to all members (including ghosts)."""
    mapset = await db.get(Mapset, mapset_id)
    if mapset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mapset not found")

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if classify_membership(membership) == MembershipKind.NONE:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

    result = await db.execute(
        select(MapsetResource)
        .where(MapsetResource.mapset_id == mapset_id)
        .order_by(MapsetResource.position, MapsetResource.created_at)
    )
    return list(result.scalars().all())


@router.post(
    "/{mapset_id}/resources",
    response_model=MapsetResourceRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf_protection), Depends(require_mapset_owner)],
)
async def create_resource(
    mapset_id: UUID,
    payload: MapsetResourceCreate,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> MapsetResource:
    """Create a resource. Owner only."""
    count = (
        await db.execute(
            select(func.count(MapsetResource.id)).where(MapsetResource.mapset_id == mapset_id)
        )
    ).scalar_one()
    if count >= _RESOURCE_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Resource limit of {_RESOURCE_LIMIT} reached",
        )

    resource = MapsetResource(
        id=payload.id,
        mapset_id=mapset_id,
        encrypted_name=payload.encrypted_name,
        encrypted_url=payload.encrypted_url,
        position=payload.position,
    )
    db.add(resource)
    await db.commit()
    await db.refresh(resource)
    return resource


@router.delete(
    "/{mapset_id}/resources/{resource_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf_protection), Depends(require_mapset_owner)],
)
async def delete_resource(
    mapset_id: UUID,
    resource_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    """Delete a resource. Owner only."""
    resource = await db.get(MapsetResource, resource_id)
    if resource is None or resource.mapset_id != mapset_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resource not found")

    await db.delete(resource)
    await db.commit()
