"""add_difficulty_section_osu_versions

Revision ID: f4c85331476e
Revises: d0cb215e010d
Create Date: 2026-05-10 20:19:09.713779

Adds Phase 3 schema:
  - difficulty, section, sectionosuversion, difficultybaseosuversion tables
  - Partial unique indexes enforcing exactly one is_active=true row per parent
  - Explicit FK indexes (PostgreSQL does not auto-index FK columns)
  - Unique constraints on (parent_id, version) preventing duplicate version numbers

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'f4c85331476e'
down_revision: Union[str, None] = 'd0cb215e010d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- difficulty ---
    op.create_table(
        'difficulty',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('mapset_id', sa.UUID(), nullable=False),
        sa.Column('encrypted_name', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['mapset_id'], ['mapset.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_difficulty_mapset_id', 'difficulty', ['mapset_id'])

    # --- section ---
    op.create_table(
        'section',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('difficulty_id', sa.UUID(), nullable=False),
        sa.Column('encrypted_name', sa.Text(), nullable=False),
        sa.Column('encrypted_start_time_ms', sa.Text(), nullable=False),
        sa.Column('encrypted_end_time_ms', sa.Text(), nullable=False),
        sa.Column('encrypted_sort_order', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['difficulty_id'], ['difficulty.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_section_difficulty_id', 'section', ['difficulty_id'])

    # --- sectionosuversion ---
    op.create_table(
        'sectionosuversion',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('section_id', sa.UUID(), nullable=False),
        sa.Column('encrypted_content', sa.Text(), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('is_active', sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column('uploaded_by', sa.UUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['section_id'], ['section.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['uploaded_by'], ['user.id'], ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('section_id', 'version', name='uq_section_osu_version_number'),
    )
    op.create_index(
        'uq_section_active_version',
        'sectionosuversion',
        ['section_id'],
        unique=True,
        postgresql_where=sa.text('is_active = true'),
    )
    op.create_index('ix_sectionosuversion_section_id', 'sectionosuversion', ['section_id'])
    op.create_index('ix_sectionosuversion_uploaded_by', 'sectionosuversion', ['uploaded_by'])

    # --- difficultybaseosuversion ---
    op.create_table(
        'difficultybaseosuversion',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('difficulty_id', sa.UUID(), nullable=False),
        sa.Column('encrypted_content', sa.Text(), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('is_active', sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column('source_section_version_id', sa.UUID(), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['difficulty_id'], ['difficulty.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(
            ['source_section_version_id'], ['sectionosuversion.id'], ondelete='SET NULL'
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(
            'difficulty_id', 'version', name='uq_difficulty_base_version_number'
        ),
    )
    op.create_index(
        'uq_difficulty_active_base',
        'difficultybaseosuversion',
        ['difficulty_id'],
        unique=True,
        postgresql_where=sa.text('is_active = true'),
    )
    op.create_index(
        'ix_difficultybaseosuversion_difficulty_id',
        'difficultybaseosuversion',
        ['difficulty_id'],
    )
    op.create_index(
        'ix_difficultybaseosuversion_source_section_version_id',
        'difficultybaseosuversion',
        ['source_section_version_id'],
    )


def downgrade() -> None:
    op.drop_index('ix_difficultybaseosuversion_source_section_version_id', table_name='difficultybaseosuversion')
    op.drop_index('ix_difficultybaseosuversion_difficulty_id', table_name='difficultybaseosuversion')
    op.drop_index('uq_difficulty_active_base', table_name='difficultybaseosuversion')
    op.drop_table('difficultybaseosuversion')
    op.drop_index('ix_sectionosuversion_uploaded_by', table_name='sectionosuversion')
    op.drop_index('ix_sectionosuversion_section_id', table_name='sectionosuversion')
    op.drop_index('uq_section_active_version', table_name='sectionosuversion')
    op.drop_table('sectionosuversion')
    op.drop_index('ix_section_difficulty_id', table_name='section')
    op.drop_table('section')
    op.drop_index('ix_difficulty_mapset_id', table_name='difficulty')
    op.drop_table('difficulty')
