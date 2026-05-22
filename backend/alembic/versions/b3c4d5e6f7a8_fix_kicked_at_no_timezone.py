"""fix_kicked_at_no_timezone

Revision ID: b3c4d5e6f7a8
Revises: 72e2dd2b631f
Create Date: 2026-05-22 00:01:00.000000

Corrects kicked_at from TIMESTAMPTZ to plain TIMESTAMP to match every other
datetime column in the schema (all naive UTC, consistent with the rest of the
app).  Existing values are converted to their UTC equivalent via AT TIME ZONE.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b3c4d5e6f7a8'
down_revision: Union[str, None] = '72e2dd2b631f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        'mapsetmember',
        'kicked_at',
        type_=sa.DateTime(timezone=False),
        existing_type=sa.DateTime(timezone=True),
        existing_nullable=True,
        postgresql_using="kicked_at AT TIME ZONE 'UTC'",
    )


def downgrade() -> None:
    op.alter_column(
        'mapsetmember',
        'kicked_at',
        type_=sa.DateTime(timezone=True),
        existing_type=sa.DateTime(timezone=False),
        existing_nullable=True,
        postgresql_using="kicked_at AT TIME ZONE 'UTC'",
    )
