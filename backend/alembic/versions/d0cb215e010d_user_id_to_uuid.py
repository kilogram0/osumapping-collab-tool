"""convert_user_pk_and_fks_to_uuid

Revision ID: d0cb215e010d
Revises: 91b2548dc0c8
Create Date: 2026-05-10 10:49:47.129740

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'd0cb215e010d'
down_revision: Union[str, None] = '91b2548dc0c8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Pre-launch schema rewrite: User.id changes from int to UUID, which
    # requires recreating dependent tables. No production rows exist yet.

    # Ensure gen_random_uuid() is available (Postgres <13 needs pgcrypto)
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")

    # Drop dependent tables (no data to preserve)
    op.drop_table('mapsetmember')
    op.drop_table('mapset')
    op.drop_table('user')

    # Recreate user with UUID PK
    op.create_table(
        'user',
        sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('osu_id', sa.Integer(), nullable=False),
        sa.Column('username', sa.String(), nullable=False),
        sa.Column('avatar_url', sa.String(), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('osu_id')
    )
    op.create_index('ix_user_osu_id', 'user', ['osu_id'], unique=True)

    # Recreate mapset with UUID owner_id
    op.create_table(
        'mapset',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('encrypted_title', sa.Text(), nullable=False),
        sa.Column('encrypted_description', sa.Text(), nullable=True),
        sa.Column('encrypted_song_length_ms', sa.Text(), nullable=False),
        sa.Column('passphrase_salt', sa.String(length=32), nullable=False),
        sa.Column('encrypted_verification', sa.Text(), nullable=False),
        sa.Column('owner_id', sa.UUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['owner_id'], ['user.id'], ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id')
    )

    # Recreate mapsetmember with UUID user_id
    op.create_table(
        'mapsetmember',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('mapset_id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('role', postgresql.ENUM('owner', 'mapper', 'modder', name='mapsetrole', create_type=False), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['mapset_id'], ['mapset.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('mapset_id', 'user_id', name='uq_mapset_member')
    )


def downgrade() -> None:
    # Reverse: drop and recreate with integer PK/FKs
    op.drop_table('mapsetmember')
    op.drop_table('mapset')
    op.drop_table('user')

    op.create_table(
        'user',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('osu_id', sa.Integer(), nullable=False),
        sa.Column('username', sa.String(), nullable=False),
        sa.Column('avatar_url', sa.String(), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('osu_id')
    )
    op.create_index('ix_user_osu_id', 'user', ['osu_id'], unique=True)

    op.create_table(
        'mapset',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('encrypted_title', sa.Text(), nullable=False),
        sa.Column('encrypted_description', sa.Text(), nullable=True),
        sa.Column('encrypted_song_length_ms', sa.Text(), nullable=False),
        sa.Column('passphrase_salt', sa.String(length=32), nullable=False),
        sa.Column('encrypted_verification', sa.Text(), nullable=False),
        sa.Column('owner_id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['owner_id'], ['user.id'], ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id')
    )

    op.create_table(
        'mapsetmember',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('mapset_id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('role', postgresql.ENUM('owner', 'mapper', 'modder', name='mapsetrole', create_type=False), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['mapset_id'], ['mapset.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('mapset_id', 'user_id', name='uq_mapset_member')
    )
