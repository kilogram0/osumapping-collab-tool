# osu! Modding Forum – AI Agent Guide

This document provides comprehensive rules and conventions for AI agents working on the Private osu! Modding Forum codebase.

## Project Overview

A private, web-based modding forum for osu! mappers to collaborate on maps that cannot be uploaded publicly. The app doubles as a collaborative beatmap manager where `.osu` files are first-class assets stored per-section and can be merged into a full difficulty.

**Tech Stack:**
- **Backend:** Python 3.12, FastAPI, SQLModel, Pydantic, Uvicorn, Alembic, pytest
- **Frontend:** React 18, TypeScript, Vite, TailwindCSS, TanStack Query, React Router
- **Database:** PostgreSQL (async via `asyncpg`)
- **Auth:** osu! OAuth 2.0 + JWT in HTTP-only cookies
- **Deployment:** Docker + Docker Compose

---

## Architecture Patterns

### Backend (FastAPI + SQLModel)

**Pattern: Dependency Injection + Router/Service Layer**

```
backend/app/
├── main.py              # App factory, middleware, mount routers
├── database.py          # Async engine, session factory, get_db dependency
├── config.py            # Pydantic Settings (env vars)
├── models.py            # SQLModel tables (the ONLY source of truth for schema)
├── schemas.py           # Pydantic request/response models (API contracts)
├── dependencies.py      # FastAPI dependencies: get_current_user, require_mapset_member
├── routers/             # One router per domain
│   ├── auth.py
│   ├── mapsets.py
│   ├── difficulties.py
│   ├── sections.py
│   └── posts.py
└── services/            # Pure business logic, NO FastAPI imports
    ├── auth_service.py  # OAuth flow, JWT creation
    └── osu_parser.py    # .osu parsing, merging, base template generation
```

**Rules:**
1. **Routers** handle HTTP concerns only: parsing input, calling services, returning responses.
2. **Services** contain business logic. They accept plain Python objects and return plain Python objects. They MUST NOT import `fastapi` or `sqlmodel` — only standard library + domain models passed in.
3. **Dependencies** (`dependencies.py`) are the ONLY place where auth/membership checks live. Inject them at the router level.
4. **Models** (`models.py`) are SQLModel tables with `table=True`. Relationships use `Relationship(back_populates=...)`.
5. **Schemas** (`schemas.py`) are Pydantic models for request/response bodies. Use separate `Create`, `Update`, `Read` classes.
6. Every database operation uses **async** SQLAlchemy (`await session.exec(...)`, `await session.commit()`).

### Frontend (React + Vite)

**Pattern: Hooks + TanStack Query for Server State, React Context for Auth**

```
frontend/src/
├── main.tsx              # Entrypoint, QueryClientProvider, AuthProvider
├── App.tsx               # Router setup
├── api/
│   ├── client.ts         # Configured Axios instance (withCredentials for cookies)
│   └── endpoints.ts      # One async function per API endpoint
├── hooks/
│   ├── useAuth.ts        # React Context + hook for current user
│   ├── useMapset.ts      # TanStack Query hooks for mapset data
│   └── useDifficulty.ts  # TanStack Query hooks for difficulty/section data
├── pages/
│   ├── LoginPage.tsx
│   ├── DashboardPage.tsx
│   └── MapsetPage.tsx
└── components/
    ├── Navbar.tsx
    ├── MapsetCard.tsx
    ├── DifficultyTabs.tsx
    ├── SectionList.tsx
    ├── PostCard.tsx
    ├── CreatePostForm.tsx
    ├── OsuUploadButton.tsx
    ├── OsuVersionHistory.tsx
    ├── BaseVersionHistory.tsx
    └── DownloadOsuButton.tsx
```

**Rules:**
1. **Server state** (anything from the API) MUST use TanStack Query (`useQuery`, `useMutation`). No manual `useEffect` + `fetch` for data loading.
2. **Mutations** MUST invalidate related queries so the UI auto-refreshes:
   ```ts
   queryClient.invalidateQueries({ queryKey: ['difficulty', did] })
   ```
3. **Auth state** (current user) lives in a React Context provided at app root. Check `useAuth()` before rendering protected routes.
4. **Components** are functional, use hooks, and receive data via props. No class components.
5. File downloads (`.osu`) use an `<a>` tag with `href` pointing to the API endpoint. Do NOT use Axios for binary downloads.

---

## File & Directory Conventions

### Backend
- **Models:** One file `app/models.py`. All tables together.
- **Schemas:** One file `app/schemas.py`. Group by domain with comments.
- **Routers:** One file per domain in `app/routers/`. Prefix routes in `main.py`.
- **Services:** One file per domain in `app/services/`. Pure functions or stateless classes.
- **Tests:** Mirror the `app/` structure under `backend/tests/`:
  ```
  backend/tests/
  ├── conftest.py
  ├── test_auth.py
  ├── test_mapsets.py
  ├── test_difficulties.py
  ├── test_sections.py
  ├── test_posts.py
  ├── test_members.py
  └── services/
      └── test_osu_parser.py
  ```

### Frontend
- **Components:** PascalCase filenames (`PostCard.tsx`). One component per file unless trivial sub-components.
- **Hooks:** camelCase with `use` prefix (`useAuth.ts`).
- **Pages:** PascalCase (`MapsetPage.tsx`).
- **API:** `client.ts` exports the Axios instance; `endpoints.ts` exports async functions.
- **Tests:** Co-locate or mirror structure. Prefer co-location: `PostCard.tsx` + `PostCard.test.tsx`.
- **CSS:** Tailwind only. No custom CSS files. Use `@apply` sparingly.

---

## Database & Migrations

- **Source of truth:** `app/models.py` (SQLModel).
- **Migration tool:** Alembic with `--autogenerate`.
- **How autogenerate works:** `alembic/env.py` imports `SQLModel.metadata` from `app.models`. Alembic diffs that metadata against the live PostgreSQL schema to produce the migration script. Therefore **every SQLModel table must be defined (or imported) in `app/models.py`** so that `SQLModel.metadata` registers it. Do not split models into separate packages unless every table is re-exported in `app/models.py`.
- **Process after any model change:**
  1. Update `models.py` (add or modify tables)
  2. Generate migration: `docker-compose exec backend alembic revision --autogenerate -m "description"`
  3. Review the generated script in `alembic/versions/` (ensure it's correct for async PostgreSQL)
  4. Apply: `docker-compose exec backend alembic upgrade head`
- **Never** manually edit existing migration files after they have been committed/applied.
- Use `selectinload` for eager loading relationships in async SQLAlchemy.

---

## Testing Rules

Testing is **mandatory** for every task. No exceptions.

### Backend Tests (pytest)
- **Frameworks:** `pytest`, `pytest-asyncio`, `httpx`
- **Run command:** `docker-compose exec backend pytest`
- **Coverage:** Cover everything that needs to be covered. We do not chase a numeric percentage — we cover the behavior that matters (every endpoint, every service function, every permission rule, every parser/merge edge case).
- **Prefer integration tests over heavy unit tests.** If a unit test needs to mock many of its collaborators (DB session, auth, other services), that's a signal the test is the wrong shape — write an integration test that exercises the real components instead. The exception is genuinely external services (osu! OAuth API, outbound HTTP), which should always be mocked.

**Required fixtures (in `conftest.py`):**
- `db_session`: async SQLModel session connected to a **dedicated PostgreSQL test container** (separate volume from the dev `db` service). Do NOT swap in SQLite — the production driver (`asyncpg`), Postgres-specific behavior (`selectinload`, partial unique indexes, JSON columns, deferrable constraints, `ENUM` types), and dialect quirks must be exercised in tests, not papered over.
- `client`: `httpx.AsyncClient` mounted to FastAPI app with `get_current_user` overridden
- `mock_user`: a `User` object injected into auth dependency
- `mock_osu_file`: valid `.osu` file content as a string

**Testing rules:**
- Every API endpoint must have at least one integration test (happy path + 403/404 edge cases).
- Every service function must have unit tests (normal + edge cases).
- Permission checks MUST be tested explicitly (e.g., `modder` cannot upload `.osu`).
- Use `monkeypatch` or `unittest.mock` to mock external HTTP calls (osu! OAuth API).

### Frontend Tests (Vitest)
- **Frameworks:** `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`
- **Run command:** `docker-compose exec frontend npm test`
- **Coverage:** Same rule as backend — cover what matters, not a number. Same integration-vs-unit guidance applies: if a component test mocks half the app, prefer rendering the real subtree with mocked network calls.

**Testing rules:**
- Every component must have a render test ("does it mount?").
- Every interactive component must have a user-event test ("does clicking X do Y?").
- Mock API calls. Never hit the real backend in tests.
- Use `vi.fn()` for mocking callbacks.

### Docker Compose Verification
After every task (or small group of related tasks), run:
```bash
docker-compose down -v
docker-compose up --build -d
docker-compose exec backend alembic upgrade head
docker-compose exec backend pytest
docker-compose exec frontend npm test
```
If any step fails, the task is NOT complete.

---

## `.osu` File Handling Conventions

These rules are critical for the merge logic to work correctly.

> **Canonical source:** `SPECIFICATION.md` §8 is the authoritative description of `.osu` parsing, base regeneration, the critical-ack flow, and merge semantics. The summary below exists so agents have the rules in front of them while editing — if it ever drifts from §8, **§8 wins**. Update §8 first, then mirror here.

### Parser Rules
1. `.osu` files are parsed as **text**, line-by-line.
2. Sections are identified by bracket headers: `[General]`, `[Metadata]`, `[Difficulty]`, `[TimingPoints]`, `[HitObjects]`, etc.
3. Timing point format: `time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects`
   - `beatLength > 0` → BPM change (uninherited = 1)
   - `beatLength < 0` → slider velocity multiplier (uninherited = 0)
4. Hit object format: `x,y,time,type,hitSound,objectParams,hitSample`
   - `time` is the millisecond timestamp used for sorting.

### Merge Rules (Full Difficulty Download)
1. Start with the **active `DifficultyBaseOsuVersion.content`** for the difficulty (headers + empty `[HitObjects]`). There is no `Difficulty.base_osu` column — the base lives in its own versioned table, parallel to `SectionOsuVersion`.
2. Collect `[TimingPoints]` from:
   - The active base (positive `beatLength` only).
   - Every section's active `.osu` file (ALL timing points — positive and negative).
3. Sort by timestamp, then **deduplicate by type**:
   - No two **positive** points at the same timestamp.
   - No two **negative** points at the same timestamp.
   - One positive + one negative at the same timestamp is allowed and preserved.
4. **Tiebreaker on collision** (same timestamp, same type): section content wins over the base; among sections, lower `Section.sort_order` wins, with `Section.id` as the stable secondary tiebreaker. The merge must be deterministic.
5. Collect `[HitObjects]` from every section's active version.
6. Sort by `time` (ascending).
7. Assemble: headers → `[TimingPoints]` → `[HitObjects]`.

### Base Template — Per-Upload Regeneration with Versioning
The base is regenerated on **every** section upload, not just the first. Every regeneration produces a new `DifficultyBaseOsuVersion` row. Active-version invariant: exactly one `is_active = true` per difficulty, enforced by a partial unique index.

**Settings buckets when comparing the candidate base to the active base:**
- **Critical** — all key/value lines in `[Difficulty]`; `AudioFilename` in `[General]`. Only **owners** can change these.
- **Notice** — rest of `[General]`, `[Events]`, `[Metadata]`, **except** `[Metadata] Version` (mappers customize this for collabs).
- **Ignored** — `[Metadata] Version`, `[TimingPoints]` (folded into the base via the positive-line filter), `[Colours]` (cosmetic), `[Editor]` (per-mapper editor state).

**Algorithm — every section upload:**
1. Validate the file (well-formed, contains `[HitObjects]`, ≤ 1 MB).
2. Compute the candidate base (everything before `[HitObjects]`, with only positive `[TimingPoints]` lines, empty `[HitObjects]`).
3. **No active base (first section upload to this difficulty):** in a single transaction, insert the section version first (to get its id), then insert the candidate base as v1 with `source_section_version_id` pointing at it. Section-first ordering is required by the FK; see §8 for details.
4. **Active base exists — diff candidate vs active base:**
   - **Critical mismatch and `acknowledge_critical` flag is NOT set →** return `409 Conflict` with the diff (which keys differ, both values). Nothing is written. The frontend then shows a role-aware modal (see Section 8 of the spec) and re-submits with `acknowledge_critical: true` if the user confirms.
   - **Critical mismatch with `acknowledge_critical: true`:**
     - **Owner:** regenerate the base with the new critical settings (new `DifficultyBaseOsuVersion`), insert the section version as-is. Single transaction.
     - **Mapper:** the base wins. Rewrite the section's critical lines to match the active base's values, then insert the (rewritten) section version. The base is **not** changed.
   - **Notice mismatch (or any positive-timing-point-line diff):** new base version + new section version. Single transaction. Response includes a `warnings` array listing which keys changed.
   - **No diff:** new section version only. Single transaction. Base untouched.

> The "single transaction" requirement is what keeps the partial-unique-index DB constraints safe — without it, the index fires mid-flight and aborts the operation.

---

## Code Style

### Python
- Format with `black` (line length 88).
- Import order: stdlib → third-party → local (`isort` compatible).
- Type hints everywhere (FastAPI enforces this via Pydantic).
- Docstrings for service functions and complex router handlers.
- `async def` for all DB-touching functions.

### TypeScript
- Strict mode enabled (`strict: true` in `tsconfig.json`).
- No `any` types. Use `unknown` if necessary, then narrow.
- Prefer `interface` over `type` for object shapes.
- Use optional chaining (`?.`) and nullish coalescing (`??`).
- Functional components with explicit return types when complex.

---

## Common Commands

```bash
# Start all services
docker-compose up --build

# Run backend tests
docker-compose exec backend pytest

# Run frontend tests (dev image only — see note below)
docker-compose exec frontend npm test

# Alembic migrations
docker-compose exec backend alembic revision --autogenerate -m "msg"
docker-compose exec backend alembic upgrade head

# Hot reload (backend)
docker-compose restart backend

# Hot reload (frontend) - automatic via Vite dev server
```

> **Frontend tests in production:** the prod `frontend` image is `nginx:alpine` serving the built `dist/` — it has no `node`, so `docker-compose exec frontend npm test` only works against the dev image. In a CI/CD pipeline, run `npm test` in the build stage **before** the multi-stage Dockerfile copies `dist/` into the nginx layer. On a deployed prod server, tests are not re-runnable in-container by design.

---

## Security Rules

1. **JWT** is stored in an **HTTP-only**, **Secure** (prod), **SameSite=Lax**, `Path=/` cookie. The cookie name is `__Host-access_token` in production and `access_token` in dev (the `__Host-` prefix requires `Secure` and dev is HTTP). `Lax` works because frontend and backend share a site (`localhost` in dev, same domain behind Nginx in prod). If frontend and backend are ever split onto different registrable domains, switch to `SameSite=None; Secure` and configure CORS for credentials.
2. **CORS** must be configured via `CORSMiddleware` to allow `FRONTEND_URL` as an explicit origin (not `*`) with `allow_credentials=True`, since the frontend sends the auth cookie via `withCredentials: true`. Allow the methods and headers the frontend actually uses.
3. **No secrets** in code. All secrets come from environment variables via Pydantic Settings.
4. ** osu! OAuth:** Only request `identify` scope.
5. **Permissions:** Every mapset-specific route MUST use `require_mapset_member` dependency. Return `403` for unauthorized access.
6. **`.osu` uploads:** Validate `[HitObjects]` is present and the file is ≤ 1 MB before storing — see SPECIFICATION.md §8 for the full validation, classification, and ack-flow rules.

---

## Pitfalls to Avoid

1. **Do NOT use sync SQLAlchemy.** The entire backend is async (`asyncpg`).
2. **Do NOT use `localStorage` for auth.** Cookies only.
3. **Do NOT manually fetch data with `useEffect`.** Use TanStack Query.
4. **Do NOT forget to invalidate queries** after mutations. Otherwise the UI won't refresh.
5. **Do NOT strip combo data from `osu://edit/` URLs.** The `(2,3,4)` part must be preserved (URL-encoded) so that opening the link selects those specific hit objects in the osu! editor.
6. **Do NOT store `.osu` files on the filesystem.** They live in PostgreSQL `TEXT` columns.
7. **Do NOT skip tests.** Every task must include tests.
8. **Do NOT skip Docker Compose verification.** Run the full stack after every task.

---

## External References

- **FastAPI + SQLModel patterns:** https://github.com/fastapi/full-stack-fastapi-template
- **Vitest testing:** https://github.com/vitest-dev/vitest
- **FastAPI docs:** https://fastapi.tiangolo.com
- **SQLModel docs:** https://sqlmodel.tiangolo.com
- **TanStack Query docs:** https://tanstack.com/query/latest
- **osu! .osu file format:** https://osu.ppy.sh/wiki/en/Client/File_formats/Osu_(file_format)
