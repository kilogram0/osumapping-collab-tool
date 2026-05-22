"""add_kicked_at_to_mapset_member

Revision ID: 72e2dd2b631f
Revises: 976dc9e8d041
Create Date: 2026-05-22 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '72e2dd2b631f'
down_revision: Union[str, None] = '976dc9e8d041'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('mapsetmember', sa.Column('kicked_at', sa.DateTime(timezone=False), nullable=True))
    op.create_index('ix_mapset_member_user_kicked', 'mapsetmember', ['user_id', 'kicked_at'])


def downgrade() -> None:
    op.drop_index('ix_mapset_member_user_kicked', table_name='mapsetmember')
    op.drop_column('mapsetmember', 'kicked_at')
