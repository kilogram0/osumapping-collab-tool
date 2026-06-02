"""Post router — encrypted forum posts within a difficulty.

All content fields are opaque ciphertext; the backend stores and returns them
verbatim.  Posts are scoped to a difficulty and may form reply trees via
``parent_id``.  Deleting a parent cascades to all replies at the DB level.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_csrf_protection
from app.models import Difficulty, Mapset, MapsetRole, Post, User
from app.queries import (
    ROW_OVERHEAD_BYTES,
    MembershipKind,
    assert_active_capacity,
    classify_membership,
    get_mapset_membership,
)
from app.schemas import PostCreate, PostRead, PostUpdate

router = APIRouter(tags=["posts"])


def _forbidden() -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


async def _get_difficulty(db: AsyncSession, difficulty_id: UUID) -> Difficulty:
    """Load a difficulty or raise 404."""
    difficulty = await db.get(Difficulty, difficulty_id)
    if difficulty is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Difficulty not found"
        )
    return difficulty


async def _get_post(
    db: AsyncSession, difficulty_id: UUID, post_id: UUID
) -> tuple[Post, UUID]:
    """Load a post verified to belong to difficulty; return (post, mapset_id)."""
    row = (
        await db.execute(
            select(Post, Difficulty.mapset_id)
            .join(Difficulty, Difficulty.id == Post.difficulty_id)
            .where(Post.id == post_id, Post.difficulty_id == difficulty_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Post not found"
        )
    post, mapset_id = row
    return post, mapset_id


@router.post(
    "/difficulties/{difficulty_id}/posts",
    response_model=PostRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf_protection)],
)
async def create_post(
    difficulty_id: UUID,
    payload: PostCreate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Post:
    """Create a post inside a difficulty.

    Any mapset member may create posts.  If ``parent_id`` is supplied, it must
    reference an existing post in the *same* difficulty.
    """
    difficulty = await _get_difficulty(db, difficulty_id)

    membership = await get_mapset_membership(
        db, difficulty.mapset_id, current_user.id
    )
    if classify_membership(membership) != MembershipKind.ACTIVE:
        raise _forbidden()

    # A post costs one row overhead plus its body against the owner's quota.
    mapset = await db.get(Mapset, difficulty.mapset_id)
    await assert_active_capacity(
        db,
        mapset.owner_id,  # type: ignore[union-attr]
        ROW_OVERHEAD_BYTES + len(payload.encrypted_body),
    )

    # Verify parent exists and belongs to the same difficulty.
    # Also enforce single-level threading: a reply may not be parented to
    # another reply (parent.parent_id must be null).
    if payload.parent_id is not None:
        parent = await db.get(Post, payload.parent_id)
        if parent is None or parent.difficulty_id != difficulty_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Parent post not found",
            )
        if parent.parent_id is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot reply to a reply — only top-level posts may have replies",
            )

    post = Post(
        id=payload.id,
        difficulty_id=difficulty_id,
        author_id=current_user.id,
        parent_id=payload.parent_id,
        tag=payload.tag,
        encrypted_body=payload.encrypted_body,
        byte_size=len(payload.encrypted_body),
    )
    db.add(post)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        # Parent may have been deleted between our existence check and commit.
        if payload.parent_id is not None:
            parent = await db.get(Post, payload.parent_id)
            if parent is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Parent post not found",
                ) from exc
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Conflict creating post",
        ) from exc
    await db.refresh(post)
    return post


@router.put(
    "/difficulties/{difficulty_id}/posts/{post_id}",
    response_model=PostRead,
    dependencies=[Depends(require_csrf_protection)],
)
async def update_post(
    difficulty_id: UUID,
    post_id: UUID,
    payload: PostUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Post:
    """Update a post's encrypted body.

    Only the original ``author_id`` may edit a post.  Returns ``403`` for
    non-authors (including the mapset owner).
    """
    post, mapset_id = await _get_post(db, difficulty_id, post_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    if classify_membership(membership) != MembershipKind.ACTIVE:
        raise _forbidden()

    if post.author_id != current_user.id:
        raise _forbidden()

    # Enforce only the *growth* against the cap — posts are many-per-difficulty
    # with no count cap, so an at-cap owner editing every post upward would
    # otherwise overshoot in aggregate. Shrinking/equal edits charge nothing.
    delta = len(payload.encrypted_body) - post.byte_size
    if delta > 0:
        mapset = await db.get(Mapset, mapset_id)
        await assert_active_capacity(db, mapset.owner_id, delta)  # type: ignore[union-attr]

    post.encrypted_body = payload.encrypted_body
    post.byte_size = len(payload.encrypted_body)
    await db.commit()
    await db.refresh(post)
    return post


@router.delete(
    "/difficulties/{difficulty_id}/posts/{post_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf_protection)],
)
async def delete_post(
    difficulty_id: UUID,
    post_id: UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    """Delete a post and all its replies.

    Permitted for the original author **or** the mapset ``owner``.  Replies
    are cascade-deleted at the DB level via ``ondelete='CASCADE'``.
    """
    post, mapset_id = await _get_post(db, difficulty_id, post_id)

    membership = await get_mapset_membership(db, mapset_id, current_user.id)
    kind = classify_membership(membership)
    if kind == MembershipKind.NONE:
        raise _forbidden()
    if kind == MembershipKind.GHOST or (
        post.author_id != current_user.id
        and membership.role != MapsetRole.owner  # type: ignore[union-attr]
    ):
        raise _forbidden()

    await db.execute(sa_delete(Post).where(Post.id == post_id))
    await db.commit()
    return None
