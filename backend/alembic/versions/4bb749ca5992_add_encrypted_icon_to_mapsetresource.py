"""add encrypted_icon to mapsetresource

Revision ID: 4bb749ca5992
Revises: b3ebf49fac20
Create Date: 2026-05-31 15:08:43.179059

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = '4bb749ca5992'
down_revision: Union[str, None] = 'b3ebf49fac20'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Scoped to this feature: add the encrypted_icon column only. Autogenerate
    # also proposed dropping the unrelated 'user_osu_id_key' unique constraint
    # (pre-existing model/DB drift — osu_id uniqueness is already enforced by the
    # unique index ix_user_osu_id); that is intentionally left out of scope.
    op.add_column('mapsetresource', sa.Column('encrypted_icon', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('mapsetresource', 'encrypted_icon')
