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
# Title/desc/song-length/verification are tiny strings; description is the
# only one a user might write at length. These bounds prevent a single
# 100 MB ``encrypted_title`` from slipping past Starlette's body-size limit.
_TITLE_CT_MAX = 2_048
_DESCRIPTION_CT_MAX = 32_768
_SONG_LENGTH_CT_MAX = 256
_VERIFICATION_CT_MAX = 256
# 16-byte salt → 24 base64 chars; allow up to 32 for padding/encoding slack.
_SALT_PATTERN = r"^[A-Za-z0-9+/=]+$"


class MapsetCreate(BaseModel):
    """Request body for ``POST /mapsets``.

    The client generates the UUID before encrypting (it is bound into the
    AAD as ``mapsets|{id}|{id}``), so ``id`` is part of the payload.
    """

    id: UUID
    encrypted_title: str = Field(min_length=1, max_length=_TITLE_CT_MAX)
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
    which fields to write; absent fields are left unchanged.  Only
    ``encrypted_description`` is nullable (sending ``null`` clears it).
    ``encrypted_title`` and ``encrypted_song_length_ms`` are non-nullable DB
    columns, so the schema keeps them as ``str`` — supplying ``null`` for
    either is a 422 validation error.
    """

    # str (not str | None): Pydantic rejects an explicit null at validation time,
    # so only a missing field reaches the default=None.  The # type: ignore
    # silences mypy's objection to a non-optional annotation with a None default.
    encrypted_title: str = Field(  # type: ignore[assignment]
        default=None, min_length=1, max_length=_TITLE_CT_MAX
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
    encrypted_title: str
    encrypted_description: str | None
    encrypted_song_length_ms: str
    passphrase_salt: str
    encrypted_verification: str
    owner_id: UUID
    created_at: datetime
    updated_at: datetime
