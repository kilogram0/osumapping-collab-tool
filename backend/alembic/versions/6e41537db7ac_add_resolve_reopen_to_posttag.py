"""add_resolve_reopen_to_posttag

Revision ID: 6e41537db7ac
Revises: c6ebd64c04c5
Create Date: 2026-05-24 12:53:25.634838

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = '6e41537db7ac'
down_revision: Union[str, None] = 'c6ebd64c04c5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # PG ≥12 allows ADD VALUE inside a transaction, but the new value cannot be
    # used in the same transaction (e.g. in an INSERT or backfill).  If a future
    # revision combines an enum-add with a backfill, split them into two separate
    # revisions or use AUTOCOMMIT for the ADD VALUE step.
    op.execute(sa.text("ALTER TYPE posttag ADD VALUE IF NOT EXISTS 'resolve'"))
    op.execute(sa.text("ALTER TYPE posttag ADD VALUE IF NOT EXISTS 'reopen'"))


def downgrade() -> None:
    # PostgreSQL does not support removing enum values; this migration is irreversible.
    pass
