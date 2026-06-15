# Potential Improvements & Faulty Elements

**Date:** 2026-06-13
**Scope:** Full-stack scan (backend FastAPI/SQLModel, frontend React/TS, docs, infra).
**Method:** Read the canonical docs (`AGENTS.md`, `SPECIFICATION.md`, prior security audit) and the implemented code, focusing on the four areas you flagged — aesthetics, front/back permission parity, optimization, and code cleanliness — plus anything else that surfaced.

> **Overall:** This is a genuinely well-engineered codebase. The E2EE model is coherent, the backend permission logic is correct and defensively written, tests are extensive, and tricky concerns (AAD binding, ghost grace periods, active/pending storage accounting, concurrent-upload races) are handled thoughtfully. The findings below are mostly *consistency, DRY, and polish* rather than serious defects. They are ordered by impact, not by the order you listed them.

---

## Priority Legend

- **P0 — Faulty / misleading:** wrong, divergent, or actively misleading; fix first.
- **P1 — High value, low risk:** large readability/maintainability win, or a real perf/UX cost.
- **P2 — Medium:** worth doing, smaller blast radius.
- **P3 — Polish:** nice-to-have, mostly aesthetics & docs.

---

## P0 — Faulty / Misleading

### 1. Permission mismatch: backend lets you assign a section to a `modder`; frontend & spec forbid it — ✅ DONE (2026-06-15)
> Owner path of `assign_section` now rejects a `modder` target with `422` ("Modders cannot be assigned sections"); non-member/ghost still returns the generic "not an active member" message. Permission test inverted to assert the rejection.
- **Backend:** [backend/app/routers/sections.py:293-302](backend/app/routers/sections.py#L293-L302) — the owner path of `assign_section` only checks that the target is an **active member**. It does *not* restrict by role, so a crafted request can assign a section to a `modder`.
- **Frontend:** [frontend/src/components/SectionDetailPanel.tsx:283](frontend/src/components/SectionDetailPanel.tsx#L283) — the assignee dropdown filters `.filter((m) => m.role !== 'modder')`.
- **Spec intent:** `SPECIFICATION.md:659,677` — *"modders are review-only; modders cannot upload `.osu` at all."*
- **Why it's faulty:** A `modder` can never upload a `.osu`, so a modder-assigned section is a dead end. The three layers disagree about whether this is even allowed. Not a security hole (the frontend is stricter), but a real correctness/consistency gap.
- **Fix:** In the owner path, reject `payload.user_id` whose membership role is `modder` with `422` (mirror the existing "Target user is not an active member" guard). Add a permission test.

### 2. Stale security audit is actively misleading — ✅ DONE (2026-06-15)
> Archived the 2026-05-07 audit with a superseded banner and published `.claude/security/2026-06-15-audit-full-stack.md` reflecting the implemented stack. Resolved H1 (application security layer) and H2 (OAuth rate limiting); carried forward the remaining supply-chain/CI items.
- **Location:** [.claude/security/2026-05-07-audit-full-stack.md:33,106-114](.claude/security/2026-05-07-audit-full-stack.md#L106-L114)
- **Problem:** Its headline **HIGH** finding (H1) states *"All auth, models, services, routes, and frontend application files remain empty stubs."* That is no longer true — the whole stack is implemented. Anyone reading this doc to gauge security posture is misled into thinking nothing is built.
- **Fix:** Re-run a security review against the *current* tree (`/security-review`) and archive or clearly mark this file as superseded. Carry forward the items below that are still genuinely open.

### 3. Deprecated, inconsistent `datetime.utcnow()` on a security boundary — ✅ DONE (2026-06-15)
> Added `utc_now_naive()` in `queries.py` and routed every call site through it (queries, main, mapsets, difficulties, members + tests). The inline `datetime.now(timezone.utc).replace(tzinfo=None)` idiom now exists only inside the helper itself and its boundary test; stray `timezone` imports removed.
- **Location:** [backend/app/queries.py:41](backend/app/queries.py#L41) (ghost grace-period expiry) and [backend/app/routers/members.py:318](backend/app/routers/members.py#L318) (setting `kicked_at`).
- **Problem:** These use `datetime.utcnow()` (deprecated in Python 3.12) while the rest of the codebase uses `datetime.now(timezone.utc).replace(tzinfo=None)` (e.g. [main.py:38](backend/app/main.py#L38), [mapsets.py:311](backend/app/routers/mapsets.py#L311)). The grace-period boundary in `classify_membership` is the line between "ghost can still read" and "no access" — correctness-sensitive. Two different idioms computing "now UTC naive" is a latent bug magnet.
- **Fix:** Add one helper, e.g. `now_utc_naive()` in `queries.py`, and use it everywhere (including tests). One source of truth for "now."

---

## P1 — High Value, Low Risk

### 4. Permission boilerplate is copy-pasted ~25× with `# type: ignore` — extract a helper/dependency — ✅ DONE (2026-06-15)
> Added `require_role()`/`require_active()` (validate + narrow) in `queries.py`; every router gate now calls them, removing nearly all `# type: ignore[union-attr]`. `resources.require_mapset_owner` consolidated onto the same helper.
- **Locations:** Nearly every handler in `routers/{mapsets,difficulties,sections,posts,pins,members}.py` repeats:
  ```python
  membership = await get_mapset_membership(db, mapset_id, current_user.id)
  if (
      classify_membership(membership) != MembershipKind.ACTIVE
      or membership.role != MapsetRole.owner  # type: ignore[union-attr]
  ):
      raise _forbidden()
  ```
- **Problem:** This is the single biggest DRY and readability issue, and it's *security-relevant* — a copy-paste slip in one of ~25 sites silently changes a permission rule. The `# type: ignore[union-attr]` litter exists only because `classify_membership` doesn't narrow the `Optional[MapsetMember]` type.
- **Fix:** Add a helper that validates *and narrows*, e.g.:
  ```python
  def require_role(member: MapsetMember | None, *roles: MapsetRole) -> MapsetMember:
      if classify_membership(member) != MembershipKind.ACTIVE or member.role not in roles:
          raise HTTPException(403, "Forbidden")
      return member  # mypy now knows it's non-None
  ```
  Callers become `member = require_role(membership, MapsetRole.owner)` with zero `# type: ignore`. Note [resources.py:33](backend/app/routers/resources.py#L33) already shows the cleaner `require_mapset_owner` dependency pattern — the other routers just don't use it. Consolidating on one approach removes dozens of lines and a whole class of bug.

### 5. Per-file helper duplication across routers — ✅ DONE (2026-06-15)
> `forbidden()`, `get_mapset_or_404()`, `get_difficulty_or_404()`, `get_section_or_404()`, `get_post_or_404()` moved into `queries.py`; all per-file `_forbidden`/`_get_*` defs removed. The `_get_section`/`_get_post` JOIN (returns `mapset_id`) is preserved.
- **Locations:** `_forbidden()` is redefined in 5 router files; `_get_difficulty()` in `sections.py`, `posts.py`, `pins.py` (and inline in `difficulties.py`); `_get_section()`/`_get_post()` follow the same shape.
- **Fix:** Move these to a shared module (`queries.py` or a new `app/_router_utils.py`). Reduces drift risk when 404/JOIN semantics change.

### 6. `MapsetPage.tsx` is a 1,346-line god component — ✅ PARTIAL (2026-06-15)
> Extracted `useMapsetPermissions` into `frontend/src/hooks/useMapsetPermissions.ts` with full test coverage. The remaining decrypt effects and hit-object scanner are still inline; deferred to a follow-up PR to keep this changeset reviewable.
- **Location:** [frontend/src/pages/MapsetPage.tsx](frontend/src/pages/MapsetPage.tsx) (largest source file by far; next is 732).
- **Problem:** It holds ~30 `useState`, several decryption `useEffect`s, all mutation handlers, role-emulation logic, and the full render tree. Hard to test, reason about, and modify without regressions.
- **Fix (incremental):** Extract cohesive units:
  - ~~`useMapsetPermissions(myMembership, emulatedRole, emulateGhost)` → `{ isOwner, canEditStructure, isGhost, effectiveRole }` (currently lines [152-168](frontend/src/pages/MapsetPage.tsx#L152-L168)).~~ ✅ DONE
  - `useDecryptedSections(difficultyDetail, mapsetId)` and `useDecryptedPosts(...)` (the decrypt effects at [197-308](frontend/src/pages/MapsetPage.tsx#L197-L308)+). — *deferred*
  - `useSectionHitObjectScan(...)` (the background scanner at [321-367](frontend/src/pages/MapsetPage.tsx#L321-L367)). — *deferred*
  - Split render into `<DifficultyHeader>`, `<SectionWorkspace>`, `<ForumPanel>` subcomponents. — *deferred*

### 7. Aesthetics: no shared UI primitives → ~10 hand-rolled modals, inconsistent styling — ✅ DONE (2026-06-15)
> Added `frontend/src/components/ui/{Button,Input,Modal,Card}.tsx` plus a semantic color-token layer in `tailwind.config.js` (`brand`, `surface`, `surface-raised`, `danger`, `success`, `muted`). Migrated `PassphraseModal`, `CreateDifficultyModal`, `CreateSectionModal`, `EditSectionModal`, `RenameDifficultyModal`, `SplitSectionModal`, and `EditMapsetModal` to the new primitives. Added render/interaction tests for `Button`, `Input`, and `Modal`.
- **Evidence:** `index.css` is just `@tailwind` + one keyframe ([frontend/src/index.css](frontend/src/index.css)); `tailwind.config.js` extends exactly one color (`gray-850`). There are ~10 `*Modal.tsx` components, each re-implementing its own overlay, panel, padding, border-radius, and focus handling. Colors like `text-blue-400`, `text-green-400`, `bg-gray-700` are hardcoded inline throughout.
- **Problem:** Inconsistent spacing/radii/focus states across dialogs; rebranding or a theme change means hunting hardcoded utility classes; no design tokens.
- **Fix (highest-leverage aesthetic work):**
  1. ~~Build a tiny primitive kit: `<Modal>` (overlay + focus trap + `Esc`/backdrop close), `<Button variant=...>`, `<Input>`, `<Card>`. Migrate modals to it for instant visual consistency.~~ ✅ DONE
  2. ~~Promote semantic color tokens into `tailwind.config.js` (`brand`, `surface`, `surface-raised`, `danger`, `success`, `muted`) instead of raw `gray-800`/`blue-400`. Then components reference intent, not hue.~~ ✅ DONE
  3. This also sets up a future light/dark toggle cheaply.

---

## P2 — Medium

### 8. Storage accounting runs on every content mutation (hot path)
- **Location:** [backend/app/queries.py:200-278](backend/app/queries.py#L200-L278) (`get_owner_storage`), called by `assert_active_capacity`/`assert_pending_capacity` on every create/upload/edit (e.g. [sections.py:384](backend/app/routers/sections.py#L384), [posts.py:91](backend/app/routers/posts.py#L91)).
- **Problem:** It runs five correlated scalar subqueries (section versions, base versions, pins, posts, sections) across all of an owner's difficulties on each write. The code itself documents this as *"heavier than the COUNT it replaced."* For a power-owner with many difficulties this is the dominant backend cost on writes.
- **Fix:** Accept for now (the docstring's reasoning is sound at current scale), but the documented escape hatch — a **trigger-maintained counter** (DB triggers *do* fire on cascade deletes, unlike app code) — is the right move if write latency ever shows up. Worth a tracking issue so the rationale isn't lost.

### 9. Several sequential DB round-trips per request that could be merged — ✅ DONE (2026-06-15)
> Extended `get_section_or_404` and `get_post_or_404` to return `owner_id` via a single `Section→Difficulty→Mapset` / `Post→Difficulty→Mapset` JOIN. Removed the follow-up `db.get(Mapset)` calls in `upload_section_osu` and `update_post`. The `create_*` helpers still use `get_difficulty_or_404`; they can be folded in the same way if the hot path ever justifies it.
- **Example:** `upload_section_osu` does `_get_section` (JOIN) → `get_mapset_membership` → `db.get(Mapset)` → `assert_active_capacity` (the big query above) → two `MAX(version)` queries → writes — all sequentially awaited ([sections.py:359-405](backend/app/routers/sections.py#L359-L405)). Similar `db.get(Difficulty)` → membership → `db.get(Mapset)` chains appear in `create_section`, `create_difficulty`, `create_post`, `create_pin`.
- **Fix:** The membership lookup and the parent-row fetch can frequently be a single JOIN (the `_get_section`/`_get_post` helpers already pull `mapset_id` this way — extend them to also return the owner_id and/or membership, eliminating one or two `db.get` round-trips). Low risk, measurable latency win on writes.

### 10. No rate limiting on the OAuth endpoints — ✅ DONE (2026-06-15)
> Added an in-memory per-IP rate limiter (`_IpRateLimiter`) in `services/rate_limit.py` and wired it as FastAPI dependencies on `/auth/osu/authorize` (20/min) and `/auth/osu/callback` (10/min). Added unit tests for the limiter and integration tests verifying 429 responses. State is per-worker; a Redis/nginx replacement is noted for multi-worker scale-out.
- **Location:** [backend/app/routers/auth.py:72,105](backend/app/routers/auth.py#L72) — `/auth/osu/authorize` and `/auth/osu/callback` have no limiter. App-level rate limiting exists only for the username-lookup fallback ([services/rate_limit.py](backend/app/services/rate_limit.py), used in `members.invite_member`).
- **Problem:** Carried over from the prior audit's still-open **H2**. The signed `state` is HMAC-protected so brute force is infeasible, but the callback can be flooded (each hit triggers outbound token-exchange + profile calls to osu!). No global API limiter either.
- **Fix:** Add `slowapi` (or an nginx `limit_req` zone) in front of `/api/auth/*`, stricter than resource routes.

### 11. Client re-decrypts everything on each difficulty switch; no plaintext cache
- **Location:** decrypt effects keyed on `difficultyDetail` ([MapsetPage.tsx:243-308](frontend/src/pages/MapsetPage.tsx#L243-L308) and the posts effect after).
- **Problem:** Switching away and back re-runs AES-GCM over all sections/posts. The hit-object scanner ([321-367](frontend/src/pages/MapsetPage.tsx#L321-L367)) additionally re-downloads + decrypts + parses every section `.osu` (concurrency 5) on load. Fine at the documented scale (<100 posts, <20 sections), but it's the main client-CPU/network cost.
- **Fix:** Memoize decrypted results per `(difficultyId, updated_at)` in a ref/Map so revisiting a difficulty is instant. The hit-scan already caches per session; extend the same idea to section/post plaintext.

### 12. Frontend bundle: no route-level code splitting
- **Problem:** Heavy, rarely-first-paint components (`PinButton` 470 lines, `FullDifficultyUploadButton` 503, `osuParser` 622, `fflate` for `.osz`) load with the main bundle. Routes are imported eagerly in [App.tsx](frontend/src/App.tsx).
- **Fix:** `React.lazy` the `MapsetPage` route and the `.osz`/merge/pin code paths so the dashboard and login pay nothing for them.

### 13. Mapper-creates-difficulty asymmetry is a UX trap (by design, but worth surfacing) — ✅ DONE (2026-06-15)
> Added a UI hint on `MapsetPage`: when the effective role is `mapper` and the selected difficulty has no sections, an amber banner reads "Only the mapset owner can add sections to this difficulty." Translations added for English and Catalan.
- **Location:** [backend/app/routers/difficulties.py:57-73](backend/app/routers/difficulties.py#L57-L73) — a `mapper` may **create** a difficulty but cannot add sections to it, rename it, or delete it (all owner-only). The frontend mirrors this (`canEditStructure` gates create, but section-add is `isOwner`-only, [MapsetPage.tsx:1122](frontend/src/pages/MapsetPage.tsx#L1122)).
- **Problem:** A mapper can make an empty difficulty and then be unable to populate it — a confusing dead state, even though both layers agree.
- **Fix:** Either let the creating mapper add sections to their own difficulty, or surface a clear hint in the UI ("Only the owner can add sections"). Product call, not a bug — flagging for intentional decision.

---

## P3 — Polish (Aesthetics, Docs, Infra)

### 14. Aesthetic polish gaps — ✅ PARTIAL (2026-06-15)
> Focus-visible: added a global `@layer base` focus ring in `index.css` so every interactive element gets a consistent visible indicator, and the new `<Button>`/`<Input>` primitives include `focus-visible` rings by default. Modal focus trap + `Esc`/backdrop close verified in tests. Remaining items (skeleton/empty states, responsiveness audit, motion) deferred.
- **Loading/empty states:** confirm every `isLoading` shows a skeleton, not bare text, and that empty lists (no sections/posts/resources) have designed empty states. — *deferred*
- **Accessibility:** ~~icon-only buttons (e.g. `iconOnly` upload button, `LanguageSwitcher`) need `aria-label`; add `focus-visible` rings to the new `<Button>` primitive; verify modal focus-trap + `Esc`.~~ ✅ DONE
- **Responsiveness:** several fixed-width panels — verify the section workspace + forum layout degrades on narrow screens. — *deferred*
- **Motion:** only one keyframe (`post-flash`). A couple of subtle transitions on hover/expand would lift perceived quality cheaply. — *deferred*

### 15. `AGENTS.md` structure diagrams have drifted from the code — ✅ DONE (2026-06-15)
> Refreshed both backend and frontend structure diagrams in `AGENTS.md` to include the missing routers (`members`, `pins`, `resources`), helpers (`queries.py`, `env.py`), services (`rate_limit.py`), hooks (`useMapsetPermissions`), components (`ui/` kit, Timeline, PinButton, ResourcesPanel, etc.), and contexts.
- **Location:** [AGENTS.md:103-159](AGENTS.md#L103-L159).
- **Drift:** The backend tree lists only `auth/mapsets/difficulties/sections/posts` — the repo also has `members.py`, `pins.py`, `resources.py`, plus `queries.py`, `env.py`, `services/rate_limit.py`. The frontend component list (~10 entries) is missing ~25 real components (Timeline, ManageMembersModal, ResourcesPanel, PinButton, etc.).
- **Fix:** ~~Refresh both diagrams, or replace them with a "generated from tree" note so they don't pretend to be exhaustive.~~ ✅ DONE

### 16. Dependency & supply-chain items still open from the prior audit
- **Dev vulns:** `vite ^5.0.8` and `@typescript-eslint/* ^6` ([frontend/package.json:31,42](frontend/package.json#L42)); the audit recommended `vite ^6` / `eslint-plugin ^8`. Run `npm audit --omit=dev` and bump.
- **Vite dev host:** the `dev` script hardcodes `--host 0.0.0.0` ([package.json:7](frontend/package.json#L7)) — binds all interfaces inside the container (audit L2). Use `127.0.0.1` unless container-external dev access is required.
- **Docker mutable tags:** audit M2 (pin to digests before prod).
- **CI:** confirm `.github/workflows` runs `pytest`, `npm test`, `npm audit --omit=dev`, and a secret scan (audit I1).

### 17. Minor consistency nits — ✅ DONE (2026-06-15)
> Replaced all `is_active == True  # noqa: E712` with `.is_(True)` in `backend/app/routers/sections.py`. Updated the two version-list docstrings to say "capped at 500" instead of "currently unbounded".
- ~~`# noqa: E712` (`== True`) appears repeatedly in `sections.py` for `is_active == True`. Prefer `.is_(True)` to drop the noqa, or keep but standardize.~~ ✅ DONE
- ~~`list_section_osu_versions` / `list_base_osu_versions` carry docstrings saying *"currently unbounded"* but actually `.limit(500)` ([sections.py:584,776](backend/app/routers/sections.py#L584)). Update the docstrings — they contradict the code.~~ ✅ DONE

---

## Suggested Sequencing

1. ~~**#1, #3** (correctness/parity) — small, surgical, removes real divergence.~~ ✅ DONE (2026-06-15)
2. ~~**#4, #5** (backend permission helper + dedupe) — biggest maintainability win, shrinks every router, kills `# type: ignore` noise, lowers permission-bug risk.~~ ✅ DONE (2026-06-15)
3. ~~**#7** (UI primitive kit + color tokens) — your top-listed concern; one focused PR yields visible, consistent polish.~~ ✅ DONE (2026-06-15)
4. ~~**#15, #17** (doc truth-up + backend nits) — cheap, prevents future confusion.~~ ✅ DONE (2026-06-15)
5. ~~**#6, #11, #12** (frontend decomposition + perf) — larger, do once the primitives exist. `#6` partially done (`useMapsetPermissions` extracted).~~ — *deferred; #13 handled instead for this pass*
6. ~~**#2** (stale security audit) — archive or supersede the misleading prior audit.~~ ✅ DONE (2026-06-15)
7. ~~**#8, #9, #10** (backend perf + rate limiting) — schedule when write latency or abuse becomes real; the hooks/notes are already in place.~~ ✅ #9, #10 DONE (2026-06-15); #8 still tracked
