"""Pydantic request/response models (API contracts)."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class UserRead(BaseModel):
    """Public user profile returned by /auth/me and member lists."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    osu_id: int
    username: str
    avatar_url: str
    created_at: datetime
    updated_at: datetime


# Per-field ciphertext caps. Plaintext budgets x ~1.4 base64 + GCM overhead.
# Description/song-length/verification are tiny strings; description is the
# only one a user might write at length. These bounds prevent a single
# 100 MB ciphertext blob from slipping past Starlette's body-size limit.
_DESCRIPTION_CT_MAX = 32_768
_SONG_LENGTH_CT_MAX = 256
_VERIFICATION_CT_MAX = 256
# 16-byte salt → 24 base64 chars; allow up to 32 for padding/encoding slack.
_SALT_PATTERN = r"^[A-Za-z0-9+/=]+$"


_TITLE_PLAIN_MAX = 255


class MapsetCreate(BaseModel):
    """Request body for ``POST /mapsets``.

    The client generates the UUID before encrypting (it is bound into the
    AAD as ``mapsets|{id}|{id}``), so ``id`` is part of the payload.
    """

    id: UUID
    title: str = Field(min_length=1, max_length=_TITLE_PLAIN_MAX)
    encrypted_description: str | None = Field(
        default=None, max_length=_DESCRIPTION_CT_MAX
    )
    encrypted_song_length_ms: str = Field(
        min_length=1, max_length=_SONG_LENGTH_CT_MAX
    )
    passphrase_salt: str = Field(
        min_length=1, max_length=32, pattern=_SALT_PATTERN
    )
    encrypted_verification: str = Field(
        min_length=1, max_length=_VERIFICATION_CT_MAX
    )


class MapsetUpdate(BaseModel):
    """Request body for ``PATCH /mapsets/{id}``.

    All fields are optional — the server uses ``model_fields_set`` to decide
    which fields to write; absent fields are left unchanged.  ``title`` is
    plaintext (not encrypted). Only ``encrypted_description`` is nullable
    (sending ``null`` clears it).  ``title`` and ``encrypted_song_length_ms``
    are non-nullable DB columns, so the schema keeps them as ``str`` —
    supplying ``null`` for either is a 422 validation error.
    """

    # str (not str | None): Pydantic rejects an explicit null at validation time,
    # so only a missing field reaches the default=None.  The # type: ignore
    # silences mypy's objection to a non-optional annotation with a None default.
    title: str = Field(  # type: ignore[assignment]
        default=None, min_length=1, max_length=_TITLE_PLAIN_MAX
    )
    encrypted_description: str | None = Field(
        default=None, max_length=_DESCRIPTION_CT_MAX
    )
    encrypted_song_length_ms: str = Field(  # type: ignore[assignment]
        default=None, min_length=1, max_length=_SONG_LENGTH_CT_MAX
    )


class MapsetRead(BaseModel):
    """Mapset row as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    encrypted_description: str | None
    encrypted_song_length_ms: str
    passphrase_salt: str
    encrypted_verification: str
    owner_id: UUID
    created_at: datetime
    updated_at: datetime


_NAME_CT_MAX = 2_048
_TIME_CT_MAX = 256
_SORT_ORDER_CT_MAX = 256


class DifficultyCreate(BaseModel):
    """Request body for ``POST /mapsets/{mapset_id}/difficulties``."""

    id: UUID
    encrypted_name: str = Field(min_length=1, max_length=_NAME_CT_MAX)


class DifficultyUpdate(BaseModel):
    """Request body for ``PATCH /difficulties/{id}``.

    Same str / default=None / type: ignore pattern as MapsetUpdate — see the
    comment there for rationale (non-nullable column, PATCH semantics).
    """

    encrypted_name: str = Field(  # type: ignore[assignment]
        default=None, min_length=1, max_length=_NAME_CT_MAX
    )


class DifficultyRead(BaseModel):
    """Difficulty row as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    mapset_id: UUID
    encrypted_name: str
    created_at: datetime
    updated_at: datetime


class SectionCreate(BaseModel):
    """Request body for ``POST /difficulties/{difficulty_id}/sections``."""

    id: UUID
    encrypted_name: str = Field(min_length=1, max_length=_NAME_CT_MAX)
    encrypted_start_time_ms: str = Field(min_length=1, max_length=_TIME_CT_MAX)
    encrypted_end_time_ms: str = Field(min_length=1, max_length=_TIME_CT_MAX)
    encrypted_sort_order: str = Field(min_length=1, max_length=_SORT_ORDER_CT_MAX)


class SectionUpdate(BaseModel):
    """Request body for ``PATCH /difficulties/{did}/sections/{sid}``.

    Same str / default=None / type: ignore pattern as MapsetUpdate — see the
    comment there for rationale (non-nullable columns, PATCH semantics).
    """

    encrypted_name: str = Field(  # type: ignore[assignment]
        default=None, min_length=1, max_length=_NAME_CT_MAX
    )
    encrypted_start_time_ms: str = Field(  # type: ignore[assignment]
        default=None, min_length=1, max_length=_TIME_CT_MAX
    )
    encrypted_end_time_ms: str = Field(  # type: ignore[assignment]
        default=None, min_length=1, max_length=_TIME_CT_MAX
    )
    encrypted_sort_order: str = Field(  # type: ignore[assignment]
        default=None, min_length=1, max_length=_SORT_ORDER_CT_MAX
    )


class SectionRead(BaseModel):
    """Section row as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    difficulty_id: UUID
    encrypted_name: str
    encrypted_start_time_ms: str
    encrypted_end_time_ms: str
    encrypted_sort_order: str
    created_at: datetime
    updated_at: datetime


# .osu file size cap (frontend validates ≤ 1 MB raw; base64 adds ~33%).
_OSU_CONTENT_CT_MAX = 1_500_000


class BaseVersionUpload(BaseModel):
    """Optional base template bundled with a section .osu upload."""

    id: UUID
    encrypted_content: str = Field(min_length=1, max_length=_OSU_CONTENT_CT_MAX)


class SectionOsuUpload(BaseModel):
    """Request body for ``POST /difficulties/{did}/sections/{sid}/osu``.

    The frontend parses the .osu file client-side, computes the candidate base,
    and optionally includes a new base version.  All IDs are client-generated
    UUIDs so that AAD can be bound before encryption.
    """

    id: UUID
    encrypted_content: str = Field(min_length=1, max_length=_OSU_CONTENT_CT_MAX)
    base_version: BaseVersionUpload | None = None


class SectionOsuRead(BaseModel):
    """A section .osu version as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    section_id: UUID
    encrypted_content: str
    version: int
    is_active: bool
    uploaded_by: UUID
    created_at: datetime
    updated_at: datetime


class BaseOsuRead(BaseModel):
    """An active base .osu version as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    encrypted_content: str


class MapsetMemberRead(BaseModel):
    """A mapset membership row as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    mapset_id: UUID
    user_id: UUID
    role: str
    created_at: datetime
    updated_at: datetime
