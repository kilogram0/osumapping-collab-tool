"""add_delete_at_to_difficulty

Revision ID: c5d6e7f8a9b0
Revises: b3c4d5e6f7a8
Create Date: 2026-05-22 00:02:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c5d6e7f8a9b0'
down_revision: Union[str, None] = 'b3c4d5e6f7a8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'difficulty',
        sa.Column('delete_at', sa.DateTime(timezone=False), nullable=True),
    )
    op.create_index(
        'ix_difficulty_mapset_delete_at',
        'difficulty',
        ['mapset_id', 'delete_at'],
    )


def downgrade() -> None:
    op.drop_index('ix_difficulty_mapset_delete_at', table_name='difficulty')
    op.drop_column('difficulty', 'delete_at')
