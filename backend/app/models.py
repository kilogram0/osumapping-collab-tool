"""SQLModel table definitions.

IMPORTANT: Alembic autogenerate diffs SQLModel.metadata against the live
PostgreSQL schema. Every table MUST be defined (or imported) in this file so
that SQLModel.metadata registers it. If you split models into sub-packages,
re-export every table class here. Failure to do so will cause autogenerate
to silently drop tables or miss new ones.
"""

from datetime import datetime

from sqlalchemy import func
from sqlmodel import Field, SQLModel

# NOTE: We use clock_timestamp() for onupdate so that updated_at advances
# even when multiple DML statements run inside the same transaction.
# PostgreSQL's now() returns transaction_timestamp(), which is frozen for
# the lifetime of the transaction. clock_timestamp() returns the actual
# wall-clock time at statement execution.


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
