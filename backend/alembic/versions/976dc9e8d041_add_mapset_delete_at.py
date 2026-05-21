"""add_mapset_delete_at

Revision ID: 976dc9e8d041
Revises: 02526a11ea29
Create Date: 2026-05-21 20:29:28.188061

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = '976dc9e8d041'
down_revision: Union[str, None] = '02526a11ea29'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('mapset', sa.Column('delete_at', sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column('mapset', 'delete_at')
