"""merge_section_assigned_to_and_difficulty_delete_at

Revision ID: c6ebd64c04c5
Revises: a1b2c3d4e5f6, c5d6e7f8a9b0
Create Date: 2026-05-23 09:14:59.973297

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = 'c6ebd64c04c5'
down_revision: Union[str, None] = ('a1b2c3d4e5f6', 'c5d6e7f8a9b0')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
