"""Tests for Section, SectionOsuVersion, and DifficultyBaseOsuVersion models."""

from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.models import (
    DifficultyBaseOsuVersion,
    Section,
    SectionOsuVersion,
)


# ---------------------------------------------------------------------------
# Helpers (section / version creation — not shared across test modules)
# ---------------------------------------------------------------------------


async def _create_section(db_session, difficulty) -> Section:
    section = Section(
        id=uuid4(),
        difficulty_id=difficulty.id,
        encrypted_name="encrypted:intro",
        encrypted_start_time_ms='{"v":0}',
        encrypted_end_time_ms='{"v":30000}',
        encrypted_sort_order='{"v":0}',
    )
    db_session.add(section)
    await db_session.commit()
    await db_session.refresh(section)
    return section


async def _create_section_version(
    db_session, section, uploader, *, is_active=False, version=1
) -> SectionOsuVersion:
    sv = SectionOsuVersion(
        id=uuid4(),
        section_id=section.id,
        encrypted_content="encrypted:osu_content",
        version=version,
        is_active=is_active,
        uploaded_by=uploader.id,
    )
    db_session.add(sv)
    await db_session.commit()
    await db_session.refresh(sv)
    return sv


# ---------------------------------------------------------------------------
# Section tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_and_read_section(db_session, mapset_difficulty):
    section = await _create_section(db_session, mapset_difficulty)

    assert section.id is not None
    assert section.created_at is not None
    assert section.updated_at is not None

    result = await db_session.execute(
        select(Section).where(Section.id == section.id)
    )
    fetched = result.scalar_one()
    assert fetched.difficulty_id == mapset_difficulty.id
    assert fetched.encrypted_name == "encrypted:intro"


@pytest.mark.asyncio
async def test_section_encrypted_name_not_null(db_session, mapset_difficulty):
    section = Section(
        id=uuid4(),
        difficulty_id=mapset_difficulty.id,
        encrypted_start_time_ms='{"v":0}',
        encrypted_end_time_ms='{"v":30000}',
        encrypted_sort_order='{"v":0}',
    )
    db_session.add(section)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_section_encrypted_start_time_ms_not_null(db_session, mapset_difficulty):
    section = Section(
        id=uuid4(),
        difficulty_id=mapset_difficulty.id,
        encrypted_name="encrypted:name",
        encrypted_end_time_ms='{"v":30000}',
        encrypted_sort_order='{"v":0}',
    )
    db_session.add(section)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_section_encrypted_end_time_ms_not_null(db_session, mapset_difficulty):
    section = Section(
        id=uuid4(),
        difficulty_id=mapset_difficulty.id,
        encrypted_name="encrypted:name",
        encrypted_start_time_ms='{"v":0}',
        encrypted_sort_order='{"v":0}',
    )
    db_session.add(section)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_section_encrypted_sort_order_not_null(db_session, mapset_difficulty):
    section = Section(
        id=uuid4(),
        difficulty_id=mapset_difficulty.id,
        encrypted_name="encrypted:name",
        encrypted_start_time_ms='{"v":0}',
        encrypted_end_time_ms='{"v":30000}',
    )
    db_session.add(section)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_section_cascades_on_difficulty_delete(db_session, mapset_difficulty):
    """Deleting a Difficulty cascades to its Sections."""
    section = await _create_section(db_session, mapset_difficulty)
    section_id = section.id

    await db_session.execute(
        text("DELETE FROM difficulty WHERE id = :did"),
        {"did": mapset_difficulty.id},
    )
    await db_session.commit()

    result = await db_session.execute(
        select(Section).where(Section.id == section_id)
    )
    assert result.scalar_one_or_none() is None


# ---------------------------------------------------------------------------
# SectionOsuVersion tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_and_read_section_osu_version(db_session, mapset_difficulty, mapset_owner):
    section = await _create_section(db_session, mapset_difficulty)
    sv = await _create_section_version(db_session, section, mapset_owner, is_active=True)

    assert sv.id is not None
    assert sv.is_active is True
    assert sv.version == 1

    result = await db_session.execute(
        select(SectionOsuVersion).where(SectionOsuVersion.id == sv.id)
    )
    fetched = result.scalar_one()
    assert fetched.encrypted_content == "encrypted:osu_content"
    assert fetched.uploaded_by == mapset_owner.id


@pytest.mark.asyncio
async def test_section_osu_version_is_active_defaults_to_false(
    db_session, mapset_difficulty, mapset_owner
):
    """Inserting without specifying is_active applies the server default (false)."""
    section = await _create_section(db_session, mapset_difficulty)

    # Construct via raw SQL so the ORM cannot smuggle a Python-side default in.
    sv_id = uuid4()
    await db_session.execute(
        text(
            "INSERT INTO sectionosuversion "
            "(id, section_id, encrypted_content, version, uploaded_by) "
            "VALUES (:id, :sid, :content, :ver, :uid)"
        ),
        {
            "id": sv_id,
            "sid": section.id,
            "content": "encrypted:default_test",
            "ver": 1,
            "uid": mapset_owner.id,
        },
    )
    await db_session.commit()

    result = await db_session.execute(
        select(SectionOsuVersion).where(SectionOsuVersion.id == sv_id)
    )
    fetched = result.scalar_one()
    assert fetched.is_active is False


@pytest.mark.asyncio
async def test_base_version_is_active_defaults_to_false(db_session, mapset_difficulty):
    """Inserting without specifying is_active applies the server default (false)."""
    base_id = uuid4()
    await db_session.execute(
        text(
            "INSERT INTO difficultybaseosuversion "
            "(id, difficulty_id, encrypted_content, version) "
            "VALUES (:id, :did, :content, :ver)"
        ),
        {
            "id": base_id,
            "did": mapset_difficulty.id,
            "content": "encrypted:default_test",
            "ver": 1,
        },
    )
    await db_session.commit()

    result = await db_session.execute(
        select(DifficultyBaseOsuVersion).where(DifficultyBaseOsuVersion.id == base_id)
    )
    fetched = result.scalar_one()
    assert fetched.is_active is False


@pytest.mark.asyncio
async def test_section_osu_version_partial_unique_index(db_session, mapset_difficulty, mapset_owner):
    """Only one SectionOsuVersion per section can have is_active=true."""
    section = await _create_section(db_session, mapset_difficulty)
    await _create_section_version(db_session, section, mapset_owner, is_active=True, version=1)

    sv2 = SectionOsuVersion(
        id=uuid4(),
        section_id=section.id,
        encrypted_content="encrypted:osu_v2",
        version=2,
        is_active=True,  # violates partial unique index
        uploaded_by=mapset_owner.id,
    )
    db_session.add(sv2)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_section_osu_version_duplicate_version_number_rejected(
    db_session, mapset_difficulty, mapset_owner
):
    """Two versions with the same version number for the same section are rejected."""
    section = await _create_section(db_session, mapset_difficulty)
    await _create_section_version(db_session, section, mapset_owner, is_active=True, version=1)

    sv2 = SectionOsuVersion(
        id=uuid4(),
        section_id=section.id,
        encrypted_content="encrypted:osu_v1_dup",
        version=1,  # duplicate version number for same section
        is_active=False,
        uploaded_by=mapset_owner.id,
    )
    db_session.add(sv2)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_section_osu_version_multiple_inactive_allowed(db_session, mapset_difficulty, mapset_owner):
    """Multiple inactive versions for the same section are allowed (distinct version numbers)."""
    section = await _create_section(db_session, mapset_difficulty)
    sv1 = await _create_section_version(db_session, section, mapset_owner, is_active=False, version=1)
    sv2 = await _create_section_version(db_session, section, mapset_owner, is_active=False, version=2)

    result = await db_session.execute(
        select(SectionOsuVersion).where(SectionOsuVersion.section_id == section.id)
    )
    ids = {r.id for r in result.scalars().all()}
    assert sv1.id in ids
    assert sv2.id in ids


@pytest.mark.asyncio
async def test_section_osu_version_cascades_on_section_delete(
    db_session, mapset_difficulty, mapset_owner
):
    """Deleting a Section cascades to its SectionOsuVersion rows."""
    section = await _create_section(db_session, mapset_difficulty)
    sv = await _create_section_version(db_session, section, mapset_owner)
    sv_id = sv.id

    await db_session.execute(
        text("DELETE FROM section WHERE id = :sid"),
        {"sid": section.id},
    )
    await db_session.commit()

    result = await db_session.execute(
        select(SectionOsuVersion).where(SectionOsuVersion.id == sv_id)
    )
    assert result.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_section_osu_version_uploader_restrict(
    db_session, mapset_difficulty, mapset_owner
):
    """Cannot delete a User who has uploaded a SectionOsuVersion (RESTRICT)."""
    section = await _create_section(db_session, mapset_difficulty)
    await _create_section_version(db_session, section, mapset_owner)

    with pytest.raises(IntegrityError):
        await db_session.execute(
            text('DELETE FROM "user" WHERE id = :uid'),
            {"uid": mapset_owner.id},
        )
    await db_session.rollback()


# ---------------------------------------------------------------------------
# DifficultyBaseOsuVersion tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_and_read_base_version(db_session, mapset_difficulty, mapset_owner):
    section = await _create_section(db_session, mapset_difficulty)
    sv = await _create_section_version(db_session, section, mapset_owner, is_active=True)

    base = DifficultyBaseOsuVersion(
        id=uuid4(),
        difficulty_id=mapset_difficulty.id,
        encrypted_content="encrypted:base_content",
        version=1,
        is_active=True,
        source_section_version_id=sv.id,
    )
    db_session.add(base)
    await db_session.commit()
    await db_session.refresh(base)

    result = await db_session.execute(
        select(DifficultyBaseOsuVersion).where(DifficultyBaseOsuVersion.id == base.id)
    )
    fetched = result.scalar_one()
    assert fetched.encrypted_content == "encrypted:base_content"
    assert fetched.source_section_version_id == sv.id
    assert fetched.is_active is True


@pytest.mark.asyncio
async def test_base_version_partial_unique_index(db_session, mapset_difficulty, mapset_owner):
    """Only one DifficultyBaseOsuVersion per difficulty can have is_active=true."""
    section = await _create_section(db_session, mapset_difficulty)
    sv = await _create_section_version(db_session, section, mapset_owner, is_active=True)

    base1 = DifficultyBaseOsuVersion(
        id=uuid4(),
        difficulty_id=mapset_difficulty.id,
        encrypted_content="encrypted:base_v1",
        version=1,
        is_active=True,
        source_section_version_id=sv.id,
    )
    db_session.add(base1)
    await db_session.commit()

    base2 = DifficultyBaseOsuVersion(
        id=uuid4(),
        difficulty_id=mapset_difficulty.id,
        encrypted_content="encrypted:base_v2",
        version=2,
        is_active=True,  # violates partial unique index
        source_section_version_id=sv.id,
    )
    db_session.add(base2)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_base_version_duplicate_version_number_rejected(
    db_session, mapset_difficulty, mapset_owner
):
    """Two base versions with the same version number for the same difficulty are rejected."""
    section = await _create_section(db_session, mapset_difficulty)
    sv = await _create_section_version(db_session, section, mapset_owner, is_active=True)

    base1 = DifficultyBaseOsuVersion(
        id=uuid4(),
        difficulty_id=mapset_difficulty.id,
        encrypted_content="encrypted:base_v1",
        version=1,
        is_active=True,
        source_section_version_id=sv.id,
    )
    db_session.add(base1)
    await db_session.commit()

    base2 = DifficultyBaseOsuVersion(
        id=uuid4(),
        difficulty_id=mapset_difficulty.id,
        encrypted_content="encrypted:base_v1_dup",
        version=1,  # duplicate version number for same difficulty
        is_active=False,
        source_section_version_id=sv.id,
    )
    db_session.add(base2)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_base_version_source_set_null_on_section_version_delete(
    db_session, mapset_difficulty, mapset_owner
):
    """Deleting a SectionOsuVersion sets source_section_version_id to NULL (not cascade)."""
    section = await _create_section(db_session, mapset_difficulty)
    sv = await _create_section_version(db_session, section, mapset_owner, is_active=True)

    base = DifficultyBaseOsuVersion(
        id=uuid4(),
        difficulty_id=mapset_difficulty.id,
        encrypted_content="encrypted:base",
        version=1,
        is_active=True,
        source_section_version_id=sv.id,
    )
    db_session.add(base)
    await db_session.commit()
    base_id = base.id  # capture before expiry

    # Delete the section (cascades to section version, which SET NULLs base pointer)
    await db_session.execute(
        text("DELETE FROM section WHERE id = :sid"),
        {"sid": section.id},
    )
    await db_session.commit()
    # Expire cached state so the next select hits the DB.
    db_session.expire_all()

    # Base version row must still exist with NULL pointer
    result = await db_session.execute(
        select(DifficultyBaseOsuVersion).where(DifficultyBaseOsuVersion.id == base_id)
    )
    fetched = result.scalar_one_or_none()
    assert fetched is not None
    assert fetched.source_section_version_id is None


@pytest.mark.asyncio
async def test_base_version_source_section_version_nullable(
    db_session, mapset_difficulty
):
    """source_section_version_id is nullable (base can exist without a source)."""
    base = DifficultyBaseOsuVersion(
        id=uuid4(),
        difficulty_id=mapset_difficulty.id,
        encrypted_content="encrypted:base",
        version=1,
        is_active=True,
        source_section_version_id=None,
    )
    db_session.add(base)
    await db_session.commit()
    await db_session.refresh(base)

    assert base.source_section_version_id is None
