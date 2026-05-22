"""add_section_assigned_to

Revision ID: a1b2c3d4e5f6
Revises: f4c85331476e
Create Date: 2026-05-23 00:00:00.000000

Adds an optional assignment column to section so members can claim ownership
of their parts. Stored as a plain FK (not encrypted) — a user_id is not
sensitive content.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = 'f4c85331476e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'section',
        sa.Column(
            'assigned_to',
            sa.UUID(),
            sa.ForeignKey('user.id', ondelete='SET NULL'),
            nullable=True,
        ),
    )
    op.create_index('ix_section_assigned_to', 'section', ['assigned_to'])


def downgrade() -> None:
    op.drop_index('ix_section_assigned_to', table_name='section')
    op.drop_column('section', 'assigned_to')
