# Grace Period Features — Implementation Plan

Two related features for protecting collaborators from unfair owner actions:

1. **Kicked mapper access grace period** — kicked members retain read-only, timestamp-filtered access for 7 days
2. **Difficulty soft delete + pending-deletion buffer** — deleted difficulties enter a 7-day grace period before purge, with a per-user buffer of 50 pending-deletion slots

---

## Background / Context

Relevant files to read before starting:

| File | Purpose |
|------|---------|
| `backend/app/models.py` | SQLAlchemy models — `Mapset`, `MapsetMember`, `Difficulty` |
| `backend/app/queries.py` | Quota helpers (`MAX_DIFFICULTY_SLOTS_PER_OWNER = 50`) |
| `backend/app/routers/mapsets.py` | Mapset CRUD + existing `schedule-delete` pattern |
| `backend/app/routers/members.py` | Member add/remove/role-change |
| `backend/app/routers/difficulties.py` | Difficulty CRUD |
| `backend/app/main.py` | Background purge task (`_purge_expired_mapsets`) |
| `frontend/src/pages/DashboardPage.tsx` | Dashboard — mapset grid, quota bar |
| `frontend/src/components/MapsetCard.tsx` | Mapset card — deletion countdown UI |
| `frontend/src/pages/MapsetPage.tsx` | Mapset page — difficulty tabs, download buttons |

The existing mapset soft-delete (`Mapset.delete_at` + `_purge_expired_mapsets`) is the direct model for both features. Read it before implementing anything else.

---

## Feature 1 — Kicked Mapper Access Grace Period

### How it works

When an owner removes a member, instead of deleting the `MapsetMember` row, set a `kicked_at` timestamp on it. For 7 days, the kicked user has read-only access to the mapset, but all queries are filtered to content that existed at or before `kicked_at`. After 7 days, the row is purged and access is gone.

The kicked mapper uses the same passphrase unlock flow as any member — no special key handling. They just see a frozen, filtered view.

### DB Migration — `add_kicked_at_to_mapset_member`

```python
# Alembic migration
op.add_column('mapset_member', sa.Column('kicked_at', sa.DateTime(timezone=True), nullable=True))
op.create_index('ix_mapset_member_user_kicked', 'mapset_member', ['user_id', 'kicked_at'])
```

`kicked_at = NULL` → active member  
`kicked_at = <timestamp>` → ghost member (grace period active)

### Backend Changes

#### `DELETE /api/mapsets/{mapset_id}/members/{user_id}` (`members.py`)

Change from hard delete to soft kick:

```python
# Before
session.delete(member)

# After
member.kicked_at = datetime.utcnow()
```

The member disappears from the active roster immediately. Their `kicked_at` timestamp is used as the filter cutoff for all subsequent access.

#### `GET /api/mapsets/{mapset_id}/members` (`members.py`)

Exclude ghost members from the response:

```python
# Add to the query filter
.where(MapsetMember.kicked_at.is_(None))
```

#### Access control (`queries.py` or a new `auth.py` helper)

The function that resolves the current user's membership (used to gate every route) needs a third outcome alongside "active member" and "not a member":

```python
class MembershipKind(Enum):
    ACTIVE = "active"
    GHOST = "ghost"      # kicked, grace period active
    NONE = "none"
```

Return `GHOST` when `kicked_at IS NOT NULL AND kicked_at + 7 days > now()`.

Ghost members are allowed through read-only routes (`GET` mapset, `GET` difficulties, `GET` sections, download routes) but blocked from all write routes. Pass the `kicked_at` timestamp down to query helpers so they can apply the timestamp filter.

#### `GET /api/mapsets/{mapset_id}` (`mapsets.py`)

Allow ghost members. No content filtering needed here (mapset-level metadata doesn't change in a way that leaks post-kick state).

#### `GET /api/mapsets/{mapset_id}/difficulties` (`difficulties.py`)

For ghost members, add a filter:

```python
# Only difficulties that existed at kick time
.where(Difficulty.created_at <= ghost_kicked_at)
# And not hard-deleted (pending-deletion difficulties are fine while they exist)
.where(or_(Difficulty.delete_at.is_(None), Difficulty.delete_at > now()))
```

#### Version endpoints (`SectionOsuVersion`, `DifficultyBaseOsuVersion`)

For ghost members, filter version lists to `created_at <= kicked_at`. This means they can download versions that existed when they were kicked, but not new ones uploaded afterward.

#### New: `GET /api/mapsets/kicked`

Returns mapsets where the current user has an active ghost membership (for the dashboard sub-section). Response shape: same as `GET /api/mapsets` but sourced from ghost memberships. Include a `kicked_at` field and a computed `access_expires_at` (`kicked_at + 7 days`) in each item.

#### Background purge (`main.py`)

Extend `_purge_expired_mapsets` (or add a sibling task):

```python
async def _purge_expired_ghost_memberships(session):
    cutoff = datetime.utcnow() - timedelta(days=7)
    await session.execute(
        delete(MapsetMember).where(MapsetMember.kicked_at <= cutoff)
    )
```

### Frontend Changes

#### Dashboard — "Removed from" sub-section (`DashboardPage.tsx`)

Add a new section below the active mapset grid, populated from `GET /api/mapsets/kicked`. Use `useQuery` (same pattern as `useMapsets()`). Only render the section if the list is non-empty.

Each card should show:
- Mapset title
- "Removed" badge
- Days of access remaining (computed from `access_expires_at`)
- "View" link that navigates to the mapset page

#### Mapset page — ghost banner (`MapsetPage.tsx`)

When `useMyMembership()` returns a ghost role:
- Show a dismissible banner at the top: _"You were removed from this mapset. Read-only access expires on \<date\>."_
- Hide all write controls: add difficulty, add section, post, rename, delete, manage members
- Leave download buttons fully functional

---

## Feature 2 — Difficulty Soft Delete + Pending-Deletion Buffer

### How it works

Deleting a difficulty schedules it for purge in 7 days (same pattern as mapset `schedule-delete`). A per-user buffer of 50 pending-deletion slots limits how many items can be in this limbo at once. The owner can restore a difficulty during its grace period (subject to active quota availability). Pending-deletion difficulties are hidden from the normal view but accessible via a toggle.

### DB Migration — `add_delete_at_to_difficulty`

```python
op.add_column('difficulty', sa.Column('delete_at', sa.DateTime(timezone=True), nullable=True))
op.create_index('ix_difficulty_mapset_delete_at', 'difficulty', ['mapset_id', 'delete_at'])
```

### Backend Changes

#### Quota helpers (`queries.py`)

Add two new constants and a new counting function alongside the existing quota helpers:

```python
MAX_PENDING_DELETION_SLOTS_PER_OWNER = 50

async def count_pending_deletion_slots(owner_id, session) -> int:
    """
    Returns total pending-deletion slots in use for this owner.
    Slot cost:
      - Each difficulty with delete_at IS NOT NULL across owner's mapsets = 1 slot
      - Each mapset with delete_at IS NOT NULL AND zero active difficulties = 1 slot
        (empty mapsets in pending deletion count as 1)
    """
```

Update the active quota counting function to **exclude** difficulties where `delete_at IS NOT NULL` — scheduling deletion frees the active slot immediately, allowing new difficulties to be created.

#### `DELETE /api/difficulties/{difficulty_id}` (`difficulties.py`)

Change from hard delete to schedule-delete:

```python
# 1. Check pending-deletion buffer
slots_used = await count_pending_deletion_slots(owner_id, session)
if slots_used >= MAX_PENDING_DELETION_SLOTS_PER_OWNER:
    raise HTTPException(409, "Pending-deletion limit reached (50 slots). "
                             "Wait for scheduled purges or restore a difficulty.")

# 2. Schedule deletion
difficulty.delete_at = datetime.utcnow() + timedelta(days=7)
```

#### New: `POST /api/difficulties/{difficulty_id}/restore` (`difficulties.py`)

Owner-only. Clears `delete_at`, restoring the difficulty to active.

```python
# 1. Check active quota — restoring adds back to active count
slots_used = await count_difficulty_slots_for_owner(owner_id, session)
if slots_used >= MAX_DIFFICULTY_SLOTS_PER_OWNER:
    raise HTTPException(409, "Active difficulty limit reached (50 slots). "
                             "Cannot restore until you delete other difficulties.")

# 2. Restore
difficulty.delete_at = None
```

#### `GET /api/mapsets/{mapset_id}/difficulties` (`difficulties.py`)

```python
# Default — exclude pending-deletion
query = query.where(Difficulty.delete_at.is_(None))

# With ?include_pending=true — include them (for "Show pending deletion" toggle)
# No extra filter; all difficulties returned
```

Ghost members (kicked) follow the same default — they see active difficulties only (filtered to their `kicked_at` timestamp as described in Feature 1). They do NOT get access to the `?include_pending=true` endpoint.

#### Background purge (`main.py`)

```python
async def _purge_expired_difficulties(session):
    cutoff = datetime.utcnow()
    await session.execute(
        delete(Difficulty).where(Difficulty.delete_at <= cutoff)
    )
```

Run this on the same 3600s interval as the mapset purge, or fold it into the same task.

### Frontend Changes

#### Mapset page — pending-deletion toggle (`MapsetPage.tsx`)

In the difficulties section header (next to the "Add difficulty" button, owner-only):

- Add a "Show deleted difficulties" toggle button
- When toggled on: re-fetch difficulties with `?include_pending=true`, render the pending-deletion ones separately below the normal tabs (they should **not** be selectable as the active difficulty tab — don't add them to `DifficultyTabs`)
- Pending-deletion difficulties render in a list with:
  - Difficulty name (decrypted, with strikethrough style)
  - "Expires in N days" label
  - "Restore" button (calls `POST /api/difficulties/{id}/restore`, then refetches)

#### Dashboard — "To be deleted" sub-section (`DashboardPage.tsx`)

Currently, mapsets with `delete_at` set appear inline with active mapsets in the grid. Move them into a clearly labelled sub-section: **"To be deleted"**, rendered below the active grid. Logic is a client-side split of the existing `useMapsets()` response — no new API call needed.

Only render this section when non-empty.

#### Buffer limit error handling

When `DELETE /api/difficulties/{id}` returns 409 (buffer full), surface a visible error (toast or inline): _"Pending-deletion limit reached. You have 50 difficulties awaiting purge. Wait for them to expire or restore some to free space."_

---

## Interaction Between Features

| Scenario | Behaviour |
|----------|-----------|
| Kicked mapper views a difficulty that is in pending deletion | Visible, as long as it was created before `kicked_at` and has not been hard-purged yet |
| Difficulty is purged while a ghost member's grace period is still active | Difficulty is gone — no extended retention for the ghost member |
| Owner deletes a difficulty, then tries to restore after filling the active quota | Restore blocked with 409; error message explains the active quota conflict |
| Ghost member tries to use `?include_pending=true` | Blocked (write/management routes gated by active membership) |

---

## Implementation Order

1. **Migration 1** — `add_kicked_at_to_mapset_member` (additive, no data migration)
2. **Migration 2** — `add_delete_at_to_difficulty` (additive, no data migration)
3. **Backend — Feature 2 quota helpers** (`queries.py`) — foundation for the buffer check
4. **Backend — Feature 2 difficulty endpoints** — schedule-delete, restore, list filter
5. **Backend — Feature 2 purge task** (`main.py`)
6. **Backend — Feature 1 access control** — ghost membership kind, filter helpers
7. **Backend — Feature 1 route changes** — kick soft-delete, member list exclusion, read-only route guards
8. **Backend — Feature 1 `GET /api/mapsets/kicked`**
9. **Backend — Feature 1 purge task** (`main.py`)
10. **Frontend — Feature 2 pending-deletion toggle** (`MapsetPage.tsx`)
11. **Frontend — Feature 2 "To be deleted" dashboard section** (`DashboardPage.tsx`)
12. **Frontend — Feature 1 "Removed from" dashboard section** (`DashboardPage.tsx`)
13. **Frontend — Feature 1 ghost banner** (`MapsetPage.tsx`)

Tests should accompany each backend step per project convention (`docker compose exec frontend npx vitest` for frontend; equivalent for backend).
