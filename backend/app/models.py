"""SQLModel table definitions.

IMPORTANT: Alembic autogenerate diffs SQLModel.metadata against the live
PostgreSQL schema. Every table MUST be defined (or imported) in this file so
that SQLModel.metadata registers it. If you split models into sub-packages,
re-export every table class here. Failure to do so will cause autogenerate
to silently drop tables or miss new ones.
"""

from datetime import datetime
from enum import Enum as PyEnum
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy import func
from sqlmodel import Field, Relationship, SQLModel

# NOTE: We use clock_timestamp() for onupdate so that updated_at advances
# even when multiple DML statements run inside the same transaction.
# PostgreSQL's now() returns transaction_timestamp(), which is frozen for
# the lifetime of the transaction. clock_timestamp() returns the actual
# wall-clock time at statement execution.


class MapsetRole(str, PyEnum):
    """Roles within a mapset collaboration."""

    owner = "owner"
    mapper = "mapper"
    modder = "modder"


class User(SQLModel, table=True):
    """A user authenticated via osu! OAuth."""

    __tablename__ = "user"

    id: int | None = Field(default=None, primary_key=True)
    osu_id: int = Field(index=True, unique=True, nullable=False)
    username: str
    avatar_url: str
    created_at: datetime | None = Field(
        default=None,
        sa_column_kwargs={
            "nullable": False,
            "server_default": func.now(),
        },
    )
    updated_at: datetime | None = Field(
        default=None,
        sa_column_kwargs={
            "nullable": False,
            "server_default": func.now(),
            "onupdate": func.clock_timestamp(),
        },
    )

    # Relationships
    owned_mapsets: list["Mapset"] = Relationship(back_populates="owner")
    mapset_memberships: list["MapsetMember"] = Relationship(
        back_populates="user"
    )


class Mapset(SQLModel, table=True):
    """An encrypted mapset (project) for collaborative modding."""

    __tablename__ = "mapset"

    id: UUID = Field(primary_key=True)
    encrypted_title: str = Field(sa_column=sa.Column(sa.Text, nullable=False))
    encrypted_description: str | None = Field(
        sa_column=sa.Column(sa.Text, nullable=True)
    )
    encrypted_song_length_ms: str = Field(
        sa_column=sa.Column(sa.Text, nullable=False)
    )
    # 16-byte random salt, base64-encoded (~24 chars). Bounded for honesty.
    passphrase_salt: str = Field(
        sa_column=sa.Column(sa.String(32), nullable=False)
    )
    encrypted_verification: str = Field(
        sa_column=sa.Column(sa.Text, nullable=False)
    )
    owner_id: int = Field(
        sa_column=sa.Column(
            sa.ForeignKey("user.id", ondelete="RESTRICT"), nullable=False
        )
    )
    created_at: datetime | None = Field(
        default=None,
        sa_column_kwargs={
            "nullable": False,
            "server_default": func.now(),
        },
    )
    updated_at: datetime | None = Field(
        default=None,
        sa_column_kwargs={
            "nullable": False,
            "server_default": func.now(),
            "onupdate": func.clock_timestamp(),
        },
    )

    # Relationships
    owner: User = Relationship(back_populates="owned_mapsets")
    members: list["MapsetMember"] = Relationship(back_populates="mapset")


class MapsetMember(SQLModel, table=True):
    """Membership of a user in a mapset with a specific role."""

    __tablename__ = "mapsetmember"

    __table_args__ = (
        sa.UniqueConstraint("mapset_id", "user_id", name="uq_mapset_member"),
    )

    id: UUID = Field(primary_key=True)
    mapset_id: UUID = Field(
        sa_column=sa.Column(
            sa.ForeignKey("mapset.id", ondelete="CASCADE"), nullable=False
        )
    )
    user_id: int = Field(
        sa_column=sa.Column(
            sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False
        )
    )
    role: MapsetRole = Field(
        default=MapsetRole.modder,
        sa_column=sa.Column(sa.Enum(MapsetRole), nullable=False),
    )
    created_at: datetime | None = Field(
        default=None,
        sa_column_kwargs={
            "nullable": False,
            "server_default": func.now(),
        },
    )
    updated_at: datetime | None = Field(
        default=None,
        sa_column_kwargs={
            "nullable": False,
            "server_default": func.now(),
            "onupdate": func.clock_timestamp(),
        },
    )

    # Relationships
    mapset: Mapset = Relationship(back_populates="members")
    user: User = Relationship(back_populates="mapset_memberships")
