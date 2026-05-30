"""SQLModel table definitions.

IMPORTANT: Alembic autogenerate diffs SQLModel.metadata against the live
PostgreSQL schema. Every table MUST be defined (or imported) in this file so
that SQLModel.metadata registers it. If you split models into sub-packages,
re-export every table class here. Failure to do so will cause autogenerate
to silently drop tables or miss new ones.
"""

from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional
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


class PostTag(str, PyEnum):
    """Tags for modding posts."""

    general = "general"
    suggestion = "suggestion"
    problem = "problem"
    praise = "praise"
    resolve = "resolve"
    reopen = "reopen"


class User(SQLModel, table=True):
    """A user authenticated via osu! OAuth."""

    __tablename__ = "user"

    id: UUID | None = Field(
        default=None,
        primary_key=True,
        sa_column_kwargs={"server_default": func.gen_random_uuid()},
    )
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
    section_uploads: list["SectionOsuVersion"] = Relationship(
        back_populates="uploader"
    )
    assigned_sections: list["Section"] = Relationship(
        back_populates="assignee",
        sa_relationship_kwargs={"foreign_keys": "Section.assigned_to"},
    )
    posts: list["Post"] = Relationship(
        back_populates="author",
        sa_relationship_kwargs={"foreign_keys": "Post.author_id"},
    )


class Mapset(SQLModel, table=True):
    """An encrypted mapset (project) for collaborative modding."""

    __tablename__ = "mapset"

    id: UUID = Field(primary_key=True)
    title: str = Field(sa_column=sa.Column(sa.String(255), nullable=False))
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
    owner_id: UUID = Field(
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
    delete_at: datetime | None = Field(
        default=None,
        sa_column_kwargs={"nullable": True},
    )

    # Relationships
    owner: User = Relationship(back_populates="owned_mapsets")
    members: list["MapsetMember"] = Relationship(back_populates="mapset")
    difficulties: list["Difficulty"] = Relationship(back_populates="mapset")
    resources: list["MapsetResource"] = Relationship(back_populates="mapset")


class MapsetMember(SQLModel, table=True):
    """Membership of a user in a mapset with a specific role."""

    __tablename__ = "mapsetmember"

    __table_args__ = (
        sa.UniqueConstraint("mapset_id", "user_id", name="uq_mapset_member"),
        sa.Index("ix_mapset_member_user_kicked", "user_id", "kicked_at"),
    )

    id: UUID = Field(primary_key=True)
    mapset_id: UUID = Field(
        sa_column=sa.Column(
            sa.ForeignKey("mapset.id", ondelete="CASCADE"), nullable=False
        )
    )
    user_id: UUID = Field(
        sa_column=sa.Column(
            sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False
        )
    )
    role: MapsetRole = Field(
        default=MapsetRole.modder,
        sa_column=sa.Column(sa.Enum(MapsetRole), nullable=False),
    )
    # NULL = active member. Non-NULL = kicked; grace period active until kicked_at + 7 days.
    kicked_at: datetime | None = Field(
        default=None,
        sa_column_kwargs={"nullable": True},
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


class Difficulty(SQLModel, table=True):
    """A difficulty within a mapset (e.g., Easy, Normal, Hard)."""

    __tablename__ = "difficulty"

    __table_args__ = (
        sa.Index("ix_difficulty_mapset_id", "mapset_id"),
        sa.Index("ix_difficulty_mapset_delete_at", "mapset_id", "delete_at"),
    )

    # Why no server_default=gen_random_uuid() like User? Per the E2EE spec, every
    # encrypted-content table requires a client-generated UUID because the row's
    # primary key is folded into the AAD before encryption. A server-side default
    # would silently mint a different UUID than the one bound into the ciphertext,
    # producing a row whose payload can never decrypt. Failing the INSERT loudly is
    # the desired behavior. (Mapset follows the same pattern.)
    id: UUID = Field(primary_key=True)
    mapset_id: UUID = Field(
        sa_column=sa.Column(
            sa.ForeignKey("mapset.id", ondelete="CASCADE"), nullable=False
        )
    )
    encrypted_name: str = Field(sa_column=sa.Column(sa.Text, nullable=False))
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
    # NULL = active. Non-NULL = pending hard deletion at this timestamp.
    delete_at: datetime | None = Field(
        default=None,
        sa_column_kwargs={"nullable": True},
    )

    # Relationships
    mapset: Mapset = Relationship(back_populates="difficulties")
    sections: list["Section"] = Relationship(back_populates="difficulty")
    posts: list["Post"] = Relationship(
        back_populates="difficulty",
        sa_relationship_kwargs={"order_by": "Post.created_at.asc()"},
    )
    base_versions: list["DifficultyBaseOsuVersion"] = Relationship(
        back_populates="difficulty"
    )


class Section(SQLModel, table=True):
    """A named time range within a difficulty, each with its own .osu version."""

    __tablename__ = "section"

    __table_args__ = (
        sa.Index("ix_section_difficulty_id", "difficulty_id"),
        sa.Index("ix_section_assigned_to", "assigned_to"),
    )

    id: UUID = Field(primary_key=True)
    difficulty_id: UUID = Field(
        sa_column=sa.Column(
            sa.ForeignKey("difficulty.id", ondelete="CASCADE"), nullable=False
        )
    )
    encrypted_name: str = Field(sa_column=sa.Column(sa.Text, nullable=False))
    encrypted_start_time_ms: str = Field(
        sa_column=sa.Column(sa.Text, nullable=False)
    )
    encrypted_end_time_ms: str = Field(
        sa_column=sa.Column(sa.Text, nullable=False)
    )
    # Encrypted: opaque to the DB, so server-side ORDER BY / uniqueness on this
    # column is impossible by design. Clients decrypt and sort in memory. Do not
    # add a backend index/constraint here — it cannot enforce anything meaningful.
    encrypted_sort_order: str = Field(
        sa_column=sa.Column(sa.Text, nullable=False)
    )
    assigned_to: UUID | None = Field(
        default=None,
        sa_column=sa.Column(
            sa.ForeignKey("user.id", ondelete="SET NULL"), nullable=True
        ),
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
    difficulty: Difficulty = Relationship(back_populates="sections")
    assignee: Optional["User"] = Relationship(
        back_populates="assigned_sections",
        sa_relationship_kwargs={"foreign_keys": "Section.assigned_to"},
    )
    osu_versions: list["SectionOsuVersion"] = Relationship(
        back_populates="section"
    )


class SectionOsuVersion(SQLModel, table=True):
    """A versioned .osu upload for a section. Exactly one per section is active."""

    __tablename__ = "sectionosuversion"

    # Partial unique index: at most one is_active=true row per section_id.
    # FK indexes for query performance. Version uniqueness prevents duplicate version numbers.
    __table_args__ = (
        sa.Index(
            "uq_section_active_version",
            "section_id",
            unique=True,
            postgresql_where=sa.text("is_active = true"),
        ),
        sa.Index("ix_sectionosuversion_section_id", "section_id"),
        sa.Index("ix_sectionosuversion_uploaded_by", "uploaded_by"),
        sa.UniqueConstraint("section_id", "version", name="uq_section_osu_version_number"),
    )

    id: UUID = Field(primary_key=True)
    section_id: UUID = Field(
        sa_column=sa.Column(
            sa.ForeignKey("section.id", ondelete="CASCADE"), nullable=False
        )
    )
    encrypted_content: str = Field(
        sa_column=sa.Column(sa.Text, nullable=False)
    )
    version: int = Field(nullable=False)
    is_active: bool = Field(
        default=False,
        sa_column=sa.Column(
            sa.Boolean, nullable=False, server_default=sa.false()
        ),
    )
    uploaded_by: UUID = Field(
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
    section: Section = Relationship(back_populates="osu_versions")
    uploader: User = Relationship(back_populates="section_uploads")
    base_versions: list["DifficultyBaseOsuVersion"] = Relationship(
        back_populates="source_section_version"
    )


class DifficultyBaseOsuVersion(SQLModel, table=True):
    """A versioned base template for a difficulty. Exactly one per difficulty is active."""

    __tablename__ = "difficultybaseosuversion"

    # Partial unique index: at most one is_active=true row per difficulty_id.
    # FK indexes for query performance. Version uniqueness prevents duplicate version numbers.
    __table_args__ = (
        sa.Index(
            "uq_difficulty_active_base",
            "difficulty_id",
            unique=True,
            postgresql_where=sa.text("is_active = true"),
        ),
        sa.Index("ix_difficultybaseosuversion_difficulty_id", "difficulty_id"),
        sa.Index(
            "ix_difficultybaseosuversion_source_section_version_id",
            "source_section_version_id",
        ),
        sa.UniqueConstraint(
            "difficulty_id", "version", name="uq_difficulty_base_version_number"
        ),
    )

    id: UUID = Field(primary_key=True)
    difficulty_id: UUID = Field(
        sa_column=sa.Column(
            sa.ForeignKey("difficulty.id", ondelete="CASCADE"), nullable=False
        )
    )
    encrypted_content: str = Field(
        sa_column=sa.Column(sa.Text, nullable=False)
    )
    version: int = Field(nullable=False)
    is_active: bool = Field(
        default=False,
        sa_column=sa.Column(
            sa.Boolean, nullable=False, server_default=sa.false()
        ),
    )
    # SET NULL: base history outlives the section version that triggered it.
    source_section_version_id: UUID | None = Field(
        default=None,
        sa_column=sa.Column(
            sa.ForeignKey("sectionosuversion.id", ondelete="SET NULL"),
            nullable=True,
        ),
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
    difficulty: Difficulty = Relationship(back_populates="base_versions")
    source_section_version: SectionOsuVersion | None = Relationship(
        back_populates="base_versions"
    )


class MapsetResource(SQLModel, table=True):
    """An encrypted named link (resource) attached to a mapset."""

    __tablename__ = "mapsetresource"

    __table_args__ = (
        sa.Index("ix_mapsetresource_mapset_id", "mapset_id"),
    )

    # Client-generated UUID — bound into AAD before encryption, same as other
    # encrypted-content tables. No server_default here by design.
    id: UUID = Field(primary_key=True)
    mapset_id: UUID = Field(
        sa_column=sa.Column(
            sa.ForeignKey("mapset.id", ondelete="CASCADE"), nullable=False
        )
    )
    encrypted_name: str = Field(sa_column=sa.Column(sa.Text, nullable=False))
    encrypted_url: str = Field(sa_column=sa.Column(sa.Text, nullable=False))
    position: int = Field(
        default=0,
        sa_column=sa.Column(sa.Integer, nullable=False, server_default="0"),
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
    mapset: Mapset = Relationship(back_populates="resources")


class Post(SQLModel, table=True):
    """A modding post within a difficulty."""

    __tablename__ = "post"

    __table_args__ = (
        sa.Index("ix_post_difficulty_id", "difficulty_id"),
        sa.Index("ix_post_author_id", "author_id"),
        sa.Index("ix_post_parent_id", "parent_id"),
    )

    id: UUID = Field(primary_key=True)
    difficulty_id: UUID = Field(
        sa_column=sa.Column(
            sa.ForeignKey("difficulty.id", ondelete="CASCADE"), nullable=False
        )
    )
    author_id: UUID = Field(
        sa_column=sa.Column(
            sa.ForeignKey("user.id", ondelete="RESTRICT"), nullable=False
        )
    )
    parent_id: UUID | None = Field(
        default=None,
        sa_column=sa.Column(
            sa.ForeignKey("post.id", ondelete="CASCADE"), nullable=True
        ),
    )
    tag: PostTag = Field(
        sa_column=sa.Column(sa.Enum(PostTag), nullable=False)
    )
    encrypted_body: str = Field(
        sa_column=sa.Column(sa.Text, nullable=False)
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
    difficulty: Difficulty = Relationship(back_populates="posts")
    author: User = Relationship(
        back_populates="posts",
        sa_relationship_kwargs={"foreign_keys": "Post.author_id"},
    )
    parent: "Post" = Relationship(
        back_populates="replies",
        sa_relationship_kwargs={
            "remote_side": "Post.id",
            "foreign_keys": "Post.parent_id",
        },
    )
    replies: list["Post"] = Relationship(
        back_populates="parent",
        sa_relationship_kwargs={"foreign_keys": "Post.parent_id"},
    )
