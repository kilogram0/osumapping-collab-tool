# Private osu! Modding Forum – Technical Specification

**Objective:** Build a private, web-based modding forum for osu! mappers to collaborate on maps that cannot be uploaded publicly (e.g., contest entries).

---

## 1. Tech Stack

| Layer | Technology | Rationale |
| :--- | :--- | :--- |
| **Frontend** | React 18 (via Vite) + TailwindCSS | Fast development server, excellent DX, easy styling. |
| **UI Primitives** | Radix UI (or Headless UI) | Provides accessible, unstyled components (Dialog, Select, Tabs, Dropdown) that we style with Tailwind. Avoids reinventing accessible DOM behavior. |
| **State Management** | TanStack Query (React Query) | Handles server state caching, background refetching, and mutation invalidation without boilerplate. |
| **Backend** | FastAPI + SQLModel + Uvicorn | SQLModel unifies Pydantic models with SQLAlchemy ORM, providing type safety and easy database interaction. |
| **Database** | PostgreSQL | Production-grade, robust, and supports async drivers. |
| **Migrations** | Alembic | Industry-standard tool for SQLAlchemy/SQLModel schema migrations. |
| **Auth** | `httpx` + JWT (HTTP-only cookies) | Handles osu! OAuth 2.0 flow securely; JWTs stored in HTTP-only cookies prevent XSS attacks. No heavy OAuth library needed for a simple code flow. |
| **Deployment** | Docker + Docker Compose | Single-command local development stack; highly portable for self-hosting on cheap VPS. |
| **API Client** | Axios (Frontend) | Mature, supports interceptors for auth cookies, and is widely used in the React ecosystem. |

---

## 2. Project Structure

We will use a monorepo structure for simplicity and to leverage Docker Compose for orchestration.

```
osu-modding-forum/
├── docker-compose.yml          # Orchestrates DB, backend, and frontend containers
├── .env.example                # Template for environment variables (copied to .env)
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt        # Python dependencies
│   ├── alembic.ini             # Alembic configuration
│   ├── alembic/                # Database migration scripts
│   └── app/
│       ├── __init__.py
│       ├── main.py             # FastAPI application entrypoint
│       ├── database.py         # Async engine, session factory, and base model
│       ├── models.py           # SQLModel database tables
│       ├── schemas.py          # Pydantic request/response models
│       ├── config.py           # Environment variables (Pydantic Settings)
│       ├── dependencies.py     # FastAPI dependencies (DB session, get_current_user)
│       ├── services/
│       │   ├── auth_service.py # osu! OAuth logic
│       │   └── osu_parser.py   # .osu parsing, base-template generation, merging, validation, timestamp extraction
│       └── routers/
│           ├── auth.py         # OAuth routes
│           ├── mapsets.py      # Mapset CRUD
│           ├── difficulties.py # Difficulty CRUD
│           ├── sections.py     # Section management
│           └── posts.py        # Forum post CRUD
└── frontend/
    ├── Dockerfile
    ├── nginx.conf              # Nginx config to serve the built SPA
    ├── index.html              # Vite entrypoint
    ├── package.json
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── vite.config.ts
    ├── tsconfig.json
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── index.css             # Tailwind directives
        ├── api/
        │   ├── client.ts         # Configured Axios instance
        │   └── endpoints.ts      # API functions
        ├── hooks/
        │   ├── useAuth.ts        # Authentication state hook
        │   ├── useMapset.ts      # Mapset data hooks (TanStack Query)
        │   └── useDifficulty.ts  # Difficulty/section/post data hooks (TanStack Query)
        ├── pages/
        │   ├── LoginPage.tsx
        │   ├── DashboardPage.tsx
        │   └── MapsetPage.tsx
        └── components/
            ├── Navbar.tsx
            ├── MapsetCard.tsx
            ├── DifficultyTabs.tsx
            ├── SectionList.tsx
            ├── Timeline.tsx
            ├── PostCard.tsx
            ├── CreatePostForm.tsx
            ├── OsuUploadButton.tsx
            ├── OsuVersionHistory.tsx
            ├── BaseVersionHistory.tsx
            └── DownloadOsuButton.tsx
```

### Components Directory Rationale
The `components/` directory contains **application-specific composite components** (e.g., `PostCard`, `Timeline`, `CreatePostForm`). These wrap Radix UI primitives (or native HTML elements) with our business logic, Tailwind styling, and API calls. We do **not** build raw `<button>` or `<select>` components from scratch; we use Radix UI or native inputs and style them with Tailwind.

---

## 3. Database Schema (SQLModel)

All models inherit from `sqlmodel.SQLModel` with `table=True`.

### `User`
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Integer` | PK, Auto-increment | Internal ID. |
| `osu_id` | `Integer` | Unique, NOT NULL | The numeric ID from the osu! API. **Immutable** — this is the stable identifier for the human; `username` and `avatar_url` are display fields and may change. (`UNIQUE` already creates an index in PostgreSQL, no separate `Index` declaration needed.) |
| `username` | `String` | | osu! username. Refreshed from `/api/v2/me` on every login. |
| `avatar_url` | `String` | | URL to the user's avatar image. Refreshed on every login. |
| `created_at` | `DateTime` | Default: `func.now()` | First-login timestamp. |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | Last time `username`/`avatar_url` were refreshed (or any other column changed). |

### `Mapset` (Renamed from `Project`)
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Integer` | PK, Auto-increment | Internal ID. |
| `name` | `String` | | Mapset title. |
| `description` | `String` | Nullable | Optional mapset description. |
| `song_length_ms` | `Integer` | | Total length of the audio in milliseconds. Used to render the timeline scrubber. Shared across all difficulties — **intentional**: a mapset is by definition one song, so all difficulties target the same `AudioFilename` and the same length. We do not enforce this at the schema level (different difficulties' `.osu` files could in principle reference different audio after a critical-ack upload), because in normal collaborative use it doesn't happen and an owner who genuinely needs different audio per diff can coordinate it manually. If a future contest needs per-difficulty audio, revisit then. |
| `owner_id` | `Integer` | FK -> `User.id`, ondelete="RESTRICT" | Creator of the mapset. RESTRICT prevents deleting a `User` who still owns mapsets — they must first transfer ownership (`PUT /mapsets/{id}/members/{user_id}`). |
| `created_at` | `DateTime` | Default: `func.now()` | |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | |

### `MapsetMember` (Renamed from `ProjectMember`)
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Integer` | PK, Auto-increment | |
| `mapset_id` | `Integer` | FK -> `Mapset.id`, ondelete="CASCADE" | Membership rows die with the mapset. |
| `user_id` | `Integer` | FK -> `User.id`, ondelete="CASCADE" | If a user is deleted (no endpoint today, but FK semantics matter), their memberships go with them. |
| `role` | `MapsetRole` (PG enum) | Default: `modder`, NOT NULL | PostgreSQL `ENUM('owner', 'mapper', 'modder')`. Use SQLModel's `Enum` type so a typo at the call site is a runtime error and the DB rejects unknown values at write time. |
| `created_at` | `DateTime` | Default: `func.now()` | When the user was added to this mapset. |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | When the role was last changed. |

**Constraint:** Unique composite index on (`mapset_id`, `user_id`).

**Role Objectives:**
- **`owner`:** Full control. Can delete the mapset, manage members (invite/remove/change roles), delete any post, and create/edit difficulties and sections. Owners cannot edit other users' posts — only the original author can edit a post (Section 4).
- **`mapper`:** Can edit mapset details, create/edit difficulties and sections, and create/edit/delete their own posts.
- **`modder`:** Can create/edit/delete their own posts only. Cannot modify mapset structure.

### `Difficulty`
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Integer` | PK, Auto-increment | |
| `mapset_id` | `Integer` | FK -> `Mapset.id`, ondelete="CASCADE" | Difficulties die with the mapset. |
| `name` | `String` | | Difficulty name (e.g., "Easy", "Normal", "Hard", "Insane"). |
| `created_at` | `DateTime` | Default: `func.now()` | |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | |

> The base template (headers + positive BPM timing points + empty hit objects) is **not** stored on `Difficulty`. It lives in `DifficultyBaseOsuVersion` (see below) so we can keep version history of the base, the same way we do for sections.

### `DifficultyBaseOsuVersion`
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Integer` | PK, Auto-increment | |
| `difficulty_id` | `Integer` | FK -> `Difficulty.id`, ondelete="CASCADE" | |
| `content` | `Text` | | The base template content: headers + filtered timing points + empty `[HitObjects]`. |
| `version` | `Integer` | | Incremental version number per difficulty. |
| `is_active` | `Boolean` | Default: `false` | Exactly one active version per difficulty. Enforced by partial unique index `WHERE is_active = true`. |
| `source_section_version_id` | `Integer` | FK -> `SectionOsuVersion.id`, Nullable, ondelete="SET NULL" | The section upload that produced this base version (for traceability). If the source section version is deleted (only happens when the section itself is deleted), keep the base version row but blank the pointer — base history must outlive its triggers. |
| `created_at` | `DateTime` | Default: `func.now()` | |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | Tracks the last `is_active` flip. The row's `content` is immutable. |

**Active version invariant:** Exactly one `DifficultyBaseOsuVersion` per `difficulty_id` has `is_active = true` whenever any base exists. Same uniqueness rule applies to `SectionOsuVersion` per `section_id`. Both are enforced at the DB level via partial unique indexes:

```sql
CREATE UNIQUE INDEX uq_section_active_version
    ON sectionosuversion (section_id) WHERE is_active = true;

CREATE UNIQUE INDEX uq_difficulty_active_base
    ON difficultybaseosuversion (difficulty_id) WHERE is_active = true;
```

Activations and rollbacks must run inside a single transaction (deactivate previous → activate new) so the invariant is never violated mid-flight.

### `Section`
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Integer` | PK, Auto-increment | |
| `difficulty_id` | `Integer` | FK -> `Difficulty.id`, ondelete="CASCADE" | Each difficulty has its own independent sections; sections die with their difficulty. |
| `name` | `String` | | Section label (e.g., "Intro", "Kiai 1"). |
| `start_time_ms` | `Integer` | | Start of the section. |
| `end_time_ms` | `Integer` | | End of the section. |
| `sort_order` | `Integer` | Default: 0 | For manual reordering. |
| `created_at` | `DateTime` | Default: `func.now()` | |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | |

### `SectionOsuVersion`
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Integer` | PK, Auto-increment | |
| `section_id` | `Integer` | FK -> `Section.id`, ondelete="CASCADE" | |
| `content` | `Text` | | The full .osu file content as uploaded. |
| `version` | `Integer` | | Incremental version number per section. |
| `is_active` | `Boolean` | Default: `false` | Only one version per section should be active. |
| `uploaded_by` | `Integer` | FK -> `User.id`, ondelete="RESTRICT" | The user who uploaded this version. RESTRICT preserves the audit trail — a `User` cannot be deleted while they have uploaded versions on record. |
| `created_at` | `DateTime` | Default: `func.now()` | |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | Tracks the last `is_active` flip. The row's `content` is immutable. |

**Active version:** A section's currently active `.osu` version is the `SectionOsuVersion` row with `is_active = true` for that `section_id`. There is exactly one active version per section at any time. We deliberately do **not** denormalize this onto `Section` (e.g., `active_osu_version_id`) to avoid a circular foreign-key dependency between the two tables and to keep a single source of truth.

### `Post`
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Integer` | PK, Auto-increment | |
| `difficulty_id` | `Integer` | FK -> `Difficulty.id`, ondelete="CASCADE" | The difficulty this post is associated with; posts die with their difficulty. |
| `author_id` | `Integer` | FK -> `User.id`, ondelete="RESTRICT" | RESTRICT preserves the audit trail — a `User` cannot be deleted while they have authored posts. |
| `timestamp_ms` | `Integer` | Nullable | **Auto-extracted** from the `content` field (first timestamp found). Used for timeline placement and sorting. |
| `hit_object_combos` | `String` | Nullable | **Auto-extracted** from the `content` field (first timestamp found). The raw combo selection string, e.g., `(2,3,4)`. **Must be preserved in the osu:// URL.** |
| `tag` | `PostTag` (PG enum) | NOT NULL | PostgreSQL `ENUM('general', 'suggestion', 'problem', 'praise')`. Same rationale as `MapsetMember.role`: typo-proof at write time. |
| `content` | `Text` | | The full body of the modding post. May contain multiple timestamps; only the first is extracted into the columns above. |
| `created_at` | `DateTime` | Default: `func.now()` | |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | |

**Section grouping is computed, not stored.** A post is attached only to a difficulty. Which `Section` a post belongs to is derived on the frontend by checking whether the post's `timestamp_ms` falls within a section's `[start_time_ms, end_time_ms]` range. Posts with no extracted timestamp are shown as "General" for that difficulty. This way, rearranging or renaming sections is a pure frontend recompute — no database migration or post updates needed.

---

## 4. API Design

**Notes:**
- All backend routes are mounted under the `/api` prefix in `main.py` (e.g., `/api/auth/me`, `/api/mapsets`). The route tables below show paths *relative to that prefix* for readability. The frontend image's nginx forwards `/api/*` to the backend without stripping the prefix.
- **Routing convention.** Collection routes are nested under their parent (`/mapsets/{id}/difficulties`, `/difficulties/{did}/sections`, `/difficulties/{did}/posts`). Item routes are flat (`/difficulties/{did}`, `/sections/{sid}`, `/posts/{pid}`). This is intentional: an item ID is globally unique within its table, so re-stating its parent in the URL is redundant. Membership/permission checks resolve the parent from the item's FK. Don't "fix" this by nesting the item routes — it's a convention, not an oversight.

### Authentication (`/auth`)
| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/auth/osu/authorize` | Initiates the OAuth flow. Generates a random `state`, sets it as the OAuth-state cookie (`__Host-oauth_state` in prod, `oauth_state` in dev — see §5; HttpOnly, short-lived), and `302`s to `https://osu.ppy.sh/oauth/authorize` with `state` and `scope=identify`. |
| `GET` | `/auth/osu/callback` | **Callback URL.** Constant-time-compares `state` against the OAuth-state cookie and clears it. Exchanges `code` for an access token, fetches `/api/v2/me`, upserts the `User` (refreshing `username`/`avatar_url` by `osu_id`), sets the JWT cookie (`__Host-access_token` in prod, `access_token` in dev), then `302`s to `${FRONTEND_URL}/dashboard`. |
| `GET` | `/auth/me` | Returns the currently authenticated `User` object based on the JWT cookie. Returns `401` if invalid or missing. |
| `POST` | `/auth/logout` | Clears the JWT cookie. |

### Mapsets (`/mapsets`)
| Method | Route | Who | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/mapsets` | Any logged-in user | Create a new mapset. Payload: `{ name, description, song_length_ms }`. Automatically adds the creator as an `owner` in `MapsetMember`. |
| `GET` | `/mapsets` | Any logged-in user | List all mapsets where the current user is a member (via `MapsetMember`). |
| `GET` | `/mapsets/{id}` | Any member | Get full mapset details, including all `Difficulty`s. Returns `403` if the user is not a member. |
| `PUT` | `/mapsets/{id}` | Owner/Mapper | Update mapset name, description, or song length. |
| `DELETE` | `/mapsets/{id}` | Owner | Delete a mapset and all related data. |

### Difficulties (`/mapsets/{id}/difficulties`)
| Method | Route | Who | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/mapsets/{id}/difficulties` | Owner/Mapper | Create a new difficulty. Payload: `{ name }`. |
| `GET` | `/mapsets/{id}/difficulties` | Any member | List all difficulties for this mapset. |
| `GET` | `/difficulties/{did}` | Any member | Get a single difficulty with all its `Section`s and `Post`s. |
| `PUT` | `/difficulties/{did}` | Owner/Mapper | Rename a difficulty. |
| `DELETE` | `/difficulties/{did}` | Owner/Mapper | Delete a difficulty and all its sections/posts. |

### Sections (`/difficulties/{did}/sections`)
| Method | Route | Who | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/difficulties/{did}/sections` | Owner/Mapper | Create a new section. Payload: `{ name, start_time_ms, end_time_ms, sort_order }`. |
| `PUT` | `/difficulties/{did}/sections/{sid}` | Owner/Mapper | Update section details. |
| `DELETE` | `/difficulties/{did}/sections/{sid}` | Owner/Mapper | Remove a section. Posts are unaffected (they're attached to the difficulty, not the section). |

### Posts (`/difficulties/{did}/posts`)
| Method | Route | Who | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/difficulties/{did}/posts` | Any member | Create a new post. Payload: `{ tag, content }`. The backend **automatically scans `content` for the first timestamp** and populates `timestamp_ms` and `hit_object_combos`. Section attribution is computed client-side from `timestamp_ms`. |
| `PUT` | `/difficulties/{did}/posts/{pid}` | Author only | Edit an existing post. Only the original `author_id` is permitted. The backend re-scans `content` and updates the extracted timestamp fields. |
| `DELETE` | `/difficulties/{did}/posts/{pid}` | Author or Owner | Delete a post. The original `author_id` or the mapset `owner`. |

### Members (`/mapsets/{id}/members`)
| Method | Route | Who | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/mapsets/{id}/members` | Any member | List all members of the mapset. Returns each `MapsetMember` joined with its `User` (username, avatar_url, osu_id) plus `role` and `created_at`. This is the explicit endpoint the "Manage Members" UI consumes; `GET /mapsets/{id}` returns the mapset with its difficulties but not the member roster, so don't conflate the two. |
| `POST` | `/mapsets/{id}/members` | Owner | Add a member. Body: `{ "username": string }`. Backend resolves the username **only against the local `User` table** — the prospective member must have logged into the forum at least once. Returns `404` if the username is unknown, `409` if they're already a member. Creates a `MapsetMember` row with role `modder` (default). |
| `PUT` | `/mapsets/{id}/members/{user_id}` | Owner | Change a member's role. Body: `{ "role": "owner" \| "mapper" \| "modder" }`. Path param is `User.id`. Setting another member to `owner` **transfers ownership**: the previous owner is automatically demoted to `mapper` in the same transaction (a mapset has exactly one `owner` at a time). Edge cases: (a) self-demotion (current owner sets their own role to `mapper`/`modder`) returns `409` — they must transfer ownership to another member first; (b) setting a role the user already holds is a `200` no-op; (c) the path-param user not being a member returns `404`; (d) setting another user to `owner` when no `owner` change is needed (i.e., target is already owner) is a `200` no-op. |
| `DELETE` | `/mapsets/{id}/members/{user_id}` | Owner | Remove a member from this mapset. The path param is `User.id` — i.e., the global user identifier the frontend already has, not `MapsetMember.id`. Backend looks up the `MapsetMember` row by `(mapset_id, user_id)` and deletes it. The owner cannot remove themselves (returns `409`); they must transfer ownership via `PUT` first, or delete the entire mapset. |

### `.osu` File Management (`/difficulties/{did}/sections/{sid}/osu`)
| Method | Route | Who | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/difficulties/{did}/sections/{sid}/osu` | Owner/Mapper | Upload a complete `.osu` file for this section. Multipart body: the file plus optional `acknowledge_critical: bool` field (default `false`). Validates `≤ 1 MB` and presence of `[HitObjects]`. Diffs the candidate base against the active base — see Section 8 for the full algorithm: critical mismatch without ack → `409` with diff; critical mismatch with ack → owner regens base, mapper has section normalized to base; notice mismatch → new `DifficultyBaseOsuVersion` + new `SectionOsuVersion`; no diff → new section version only. All persistence runs in a single transaction. |
| `GET` | `/difficulties/{did}/sections/{sid}/osu` | Any member | Download the section's current active `.osu` file exactly as uploaded (for editing). Returns `404` if none uploaded. |
| `GET` | `/difficulties/{did}/base.osu` | Any member | Download the active base template: headers + positive BPM timing points, empty hit objects. Returns `404` until the first section upload. |
| `GET` | `/difficulties/{did}/merged.osu` | Any member | Download the full merged difficulty. Backend combines: active base headers + deduplicated & sorted timing points + all hit objects from all active section versions sorted by timestamp. |
| `GET` | `/difficulties/{did}/base/versions` | Any member | List base version history (version number, source section version, created_at, is_active). |
| `POST` | `/difficulties/{did}/base/versions/{vid}/activate` | Owner/Mapper | Roll back to a previous base version. Single-transaction flip. |
| `GET` | `/difficulties/{did}/sections/{sid}/osu/versions` | Any member | List section version history (version number, uploaded_by, created_at, is_active). |
| `POST` | `/difficulties/{did}/sections/{sid}/osu/versions/{vid}/activate` | Owner/Mapper | Roll back to a previous section version. Single-transaction flip. |

**Permission Note:** All `.osu` upload and version management routes require `owner` or `mapper` role. `modder` cannot upload or modify `.osu` files.

---

## 5. Authentication & Security

### osu! OAuth 2.0 Flow
1. **Initiation:** Frontend full-page navigates to `GET /api/auth/osu/authorize` (full-page nav, not Axios — this is a redirect chain ending on the osu! site).
2. **State generation (CSRF defense):** Backend generates a cryptographically random `state` value, stores it in a short-lived (`Max-Age=600`), `HttpOnly`, `SameSite=Lax`, `Secure` (prod) cookie. The cookie name is `__Host-oauth_state` in production and `oauth_state` in dev. The `__Host-` prefix is a browser-enforced hardening: the cookie must be `Secure`, `Path=/`, and have no `Domain` attribute, which protects it from being set by subdomains or over HTTP. Dev drops the prefix because dev runs over HTTP and the prefix requires `Secure`. The state value is included in the authorize URL:
   ```
   https://osu.ppy.sh/oauth/authorize
   ?client_id=<OSU_CLIENT_ID>
   &redirect_uri=<BACKEND_URL>/api/auth/osu/callback
   &response_type=code
   &scope=identify
   &state=<random>
   ```
   We only request the `identify` scope — no extra permissions are needed. The `state` parameter prevents login-CSRF: an attacker cannot trick a victim's browser into completing an OAuth flow tied to the attacker's account, because the callback rejects any `state` that doesn't match the cookie set on this browser.
3. **Callback:** The user approves on the osu! website and is redirected back to `/api/auth/osu/callback?code=...&state=...`.
4. **State verification:** Backend reads the OAuth-state cookie and compares it to the `state` query param using a constant-time comparison (`secrets.compare_digest`), then clears the cookie. If they don't match or the cookie is missing, return `400`. Constant-time comparison prevents timing-leak attacks on the random state — irrelevant for short-lived nonces in practice, but it's a one-line cost and the right reflex for any auth-flow string compare.
5. **Token Exchange:** Backend makes a `POST` to `https://osu.ppy.sh/oauth/token` with the `code`, `client_id`, `client_secret`, and `redirect_uri`.
6. **User Info:** Backend calls `GET https://osu.ppy.sh/api/v2/me` with the received access token. The `osu_id` in the returned payload is the stable identifier; `username` and `avatar_url` are mutable display fields.
7. **User upsert:** Backend looks up `User` by `osu_id` (immutable). If found, it refreshes `username` and `avatar_url` from the API response — these can change between logins. If not found, a new row is inserted.
8. **Session Creation:** Backend generates a JWT containing `sub` (internal `User.id`) and `exp` set to **14 days** from issue. The JWT is set as an **HTTP-only**, **Secure** (prod), **SameSite=Lax** cookie with `Path=/` and `Max-Age` matching the JWT's TTL. The cookie name is `__Host-access_token` in production and `access_token` in dev — same prefix policy as the OAuth-state cookie above. The `__Host-` prefix is browser-enforced hardening: the cookie must be `Secure`, `Path=/`, and have no `Domain` attribute, blocking subdomain or HTTP injection of a forged session cookie. Dev drops the prefix because dev runs over HTTP and the prefix requires `Secure`. We pick 14 days because contests typically run 15+ days — a shorter TTL would force participants to re-auth mid-collab. There is no refresh-token flow; on expiry, the user logs in again. (The 14-day value should live in `config.py` as `ACCESS_TOKEN_TTL_DAYS` so it can be adjusted without a code change elsewhere.)
9. **Post-callback redirect:** Backend returns a `302` to `${FRONTEND_URL}/dashboard` so the user lands in the app rather than on a JSON endpoint.

   > **Cross-origin caveat:** `SameSite=Lax` works in local dev because both frontend (`localhost:5173`) and backend (`localhost:8000`) share the same site (`localhost`). It also works in production when both are served from the same domain via the nginx reverse proxy (see Section 13). If you ever split the frontend and backend onto different registrable domains (e.g., `app.example.com` vs `api.other.com`), the cookie must be changed to `SameSite=None; Secure`, and CORS must be configured for credentials.
10. **Authenticated Requests:** The browser automatically sends the `access_token` cookie with every request. FastAPI dependency `get_current_user` verifies the JWT signature and expiry, fetches the `User` from the DB by internal `id`, and injects it into the route handler.

### Are Cookies Dangerous / Legal Issues?
**No.** HTTP-only cookies are the **industry standard** for session management and are the *safest* technical method for storing authentication tokens. Because they are HTTP-only, JavaScript cannot read them, which completely prevents XSS token theft.

Regarding laws (GDPR / ePrivacy): **session cookies that are strictly necessary for authentication are exempt from consent requirements.** You are not being sued for using a login cookie. Using `localStorage` would be less secure and would not improve your legal standing. We will use cookies.

### CORS
The backend mounts FastAPI's `CORSMiddleware` with:
- `allow_origins=[FRONTEND_URL]` — explicit origin, never `*`.
- `allow_credentials=True` — required because the frontend issues requests with `withCredentials: true` so the `access_token` cookie is sent.
- `allow_methods` and `allow_headers` set to the methods/headers the frontend actually uses (default to standard set + `Content-Type`, `Authorization`).

The `*` wildcard is incompatible with `allow_credentials=True` per the CORS spec, so a typo there fails loudly rather than silently relaxing cookie auth.

### Authorization
- **Private Mapsets:** Every mapset is strictly private. The `GET /mapsets` endpoint must perform a SQL join with `MapsetMember` to filter results.
- **Middleware/Dependency:** A `require_mapset_member(mapset_id)` dependency will be used on all mapset-specific routes. It checks if `current_user.id` exists in `MapsetMember` for that `mapset_id`. Returns `403 Forbidden` if not.
- **Role Enforcement:**
  - `owner`: Full control (CRUD mapset, manage members, delete any post).
  - `mapper`: Can edit mapset details, manage difficulties/sections, create/edit/delete their own posts.
  - `modder`: Can create/edit/delete their own posts only.

---

## 6. Frontend Architecture

### Routing (React Router)
- `/login`: Simple page with a "Login with osu!" button.
- `/dashboard`: Grid/list of mapsets the user is a member of. Button to create a new mapset.
- `/mapsets/:id`: The main Mapset View page.

### Mapset View Layout
This is the core of the application. It will be a single-page layout:

1. **Header Bar:**
   - Mapset name and description.
   - Song length displayed as `MM:SS`.
   - "Manage Members" button (for Owner/Mapper).
   - **"Download Base Template"** button (downloads the active base template for the selected difficulty).
   - **"Download Full Difficulty (.osu)"** button (downloads the merged difficulty).

2. **Difficulty Tabs / Selector (Below Header):**
   - Tabs or a dropdown listing all difficulties in the mapset (e.g., Easy, Normal, Hard).
   - Selecting a difficulty loads its specific sections and posts.
   - "Add Difficulty" button (for Owner/Mapper).

3. **Section Sidebar (Left):**
   - List of sections for the **currently selected difficulty**.
   - Clicking a section filters the forum posts.
   - "Add Section" and "Edit Section" controls (for Owner/Mapper).
   - Each section row shows a small **uploader indicator** for the active `.osu` version: the uploader's avatar (or a fallback icon if no `.osu` has been uploaded yet) with a tooltip on hover that reads `Last upload: <username> · <relative time>`. This is the at-a-glance "whose version is current?" affordance — full history is still available via Version History.
   - **Per-section `.osu` controls** (for Owner/Mapper):
     - "Upload .osu" button (file picker).
     - "Download .osu" button (downloads the exact uploaded file for editing).
     - "Version History" button (lists past uploads, allows rollback).

4. **Timeline Scrubber (Top of Main Area):**
   - A horizontal bar representing the full `song_length_ms` of the mapset.
   - Visual markers/dots indicate where posts with `timestamp_ms` exist **for the current difficulty**.
   - Clicking anywhere on the bar sets a "Current Time" state.
   - Zooming/panning is **not** required for the MVP; a simple linear scale is sufficient.

5. **Forum Thread (Main Area):**
   - Chronological list of `PostCard` components for the selected difficulty.
   - "New Post" input box at the top or bottom.
   - **No pagination.** osu!'s own forums don't paginate modding threads, and a typical difficulty rarely exceeds ~100 posts. The full list is fetched and rendered.
   - **Collapsible posts.** Each `PostCard` has a collapse/expand affordance (chevron in the header). Collapsed state shows only the header (avatar, username, tag badge, primary timestamp link, post date) and hides the body and actions, so users can scroll past threads they've already addressed without losing them. Collapse state is per-user, per-post, persisted to `localStorage` keyed on `(user_id, post_id)` — it's a UI preference, not server state. A "Collapse all" / "Expand all" button in the thread header toggles every post in the current view.

### Key Components

#### `PostCard`
- **Author Info:** Avatar (small circle), username.
- **Tag Badge:** Color-coded badge (e.g., Blue for Suggestion, Red for Problem, Green for Praise, Grey for General).
- **Primary Timestamp Link:**
  - If `timestamp_ms` exists, display a clickable link.
  - Format: `osu://edit/MM:SS:MMM` or `osu://edit/MM:SS:MMM%20(combos)`.
  - Example: `<a href="osu://edit/00:46:140%20(2,3,4)">00:46:140 (2,3,4)</a>`.
  - Clicking this triggers the browser to open the osu! client.
- **Content:** The text body. The frontend should also scan the text and turn any other valid timestamps into clickable links, even though only the first one is stored in the DB columns.
- **Actions:** "Edit" and "Delete" buttons, visible only if the current user is the author (or mapset owner).

#### `CreatePostForm`
- **No separate timestamp input field.** Users simply write their post in a `Textarea`.
- **Tag Selector:** Dropdown for `general`, `suggestion`, `problem`, `praise`.
- **Content:** Textarea. Users paste strings like `00:46:140 (2,3,4) - these are too close` directly.
- **No section selector.** The post's section is derived from its extracted timestamp on the frontend.
- **Submit Button:** Creates the post via `POST /difficulties/{did}/posts`. The backend handles timestamp extraction.

#### `OsuUploadButton`
- Simple file input wrapper (hidden `<input type="file" accept=".osu">`) triggered by a styled button.
- On file selection, uploads via `POST /difficulties/{did}/sections/{sid}/osu`.
- Shows upload progress and success/error states.

#### `OsuVersionHistory`
- Modal or dropdown listing all versions for a section.
- Displays version number, uploader avatar/username, timestamp, and active status.
- "Activate" button on each non-active version to rollback.

#### `DownloadOsuButton`
- A simple anchor link or button that triggers a file download.
- Used for: section `.osu` download, base template download, and merged difficulty download.

### State Management
- **Global Auth State:** Managed via `useAuth` hook and React Context. Checks `/auth/me` on app load.
- **Server State:** All mapset, difficulty, section, and post data is managed via TanStack Query (`useQuery`, `useMutation`).
  - Mutations (create/edit/delete post) will invalidate the difficulty query to automatically refresh the forum thread.

---

## 7. Timestamp & osu:// Link Logic

### Input Format
Users will copy strings from the osu! editor status bar or type them manually. These appear inline in their post `content`:
- `00:46:140`
- `00:46:140 (2,3,4)`
- `01:47:766`
- `01:47:766 (5)`

A single post may contain multiple timestamps:
> "00:46:140 (2,3,4) - these circles are too close. Also 01:47:766 feels a bit empty."

### Backend Extraction Logic
When creating or updating a post, the backend scans `content` for the **first** valid timestamp and extracts it into the database columns. The rest of the text remains untouched.

```python
import re

def extract_first_timestamp(content: str) -> dict | None:
    """
    Scans text for the first occurrence of a timestamp like '00:46:140' or '00:46:140 (2,3,4)'.
    Returns: { 'ms': int, 'combos': str | None } or None if no match found.
    """
    # Regex looks for MM:SS:MMM optionally followed by space + (numbers).
    # The strict {2}:{2}:{3} shape is intentional and safe: users do not type
    # timestamps by hand. They select hit objects in the osu! editor and copy,
    # which always emits the canonical zero-padded MM:SS:MMM form (with combos).
    # Abbreviated forms like "0:46:14" are not produced by the client and so
    # are not a concern here.
    #
    # Known limit: this matches up to 99:59:999 (~100 minutes). The longest
    # ranked osu! map is roughly an hour, so this is fine for the contests
    # this tool targets. If a future use case involves a >99-minute map
    # (unlikely on a collab), widen the minutes group then.
    pattern = r'(\d{2}):(\d{2}):(\d{3})(?:\s+(\([^)]+\)))?'
    match = re.search(pattern, content)
    if not match:
        return None
    
    minutes, seconds, milliseconds, combos = match.groups()
    total_ms = int(minutes) * 60000 + int(seconds) * 1000 + int(milliseconds)
    
    return {
        "ms": total_ms,
        "combos": combos  # e.g., "(2,3,4)"
    }
```

### URL Generation (Frontend)
When rendering the primary timestamp link from the DB columns:
```typescript
function generateOsuLink(ms: number, combos?: string): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = ms % 1000;
  
  const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(milliseconds).padStart(3, '0')}`;
  
  if (combos) {
    return `osu://edit/${timeStr}%20${combos}`;
  }
  return `osu://edit/${timeStr}`;
}
```
**Critical:** Do not strip or modify the `(2,3,4)` part. It must be URL-encoded (space becomes `%20`) and appended to the link so that opening osu! selects those specific hit objects.

---

## 8. `.osu` File Management & Merging

This is a core feature that transforms the forum into a collaborative beatmap manager. Each `Section` can have its own `.osu` file, and the full difficulty can be downloaded as a merged, valid `.osu` file.

### Storage
Since `.osu` files are small (a few KB), they are stored as `TEXT` columns directly in PostgreSQL. This ensures portability, simple backups, and easy version control. Uploaded files are capped at **1 MB** — generous for a text format, and any larger file is almost certainly malformed or malicious.

### What we store, what we don't
A `.osu` file is **just a text file** describing a beatmap: headers, timing points, hit objects, and references (by filename) to external assets. We store and serve only the `.osu` text. We do **not** store, upload, or merge:
- **Audio** (`AudioFilename` references the mapper's local `.mp3`/`.ogg`)
- **Background images / video** (referenced from `[Events]`)
- **Custom hitsounds** (the `.wav` files referenced from `[Events]` or hit object samples)
- **Skin elements** (any image/sound override)

The merged difficulty download (`merged.osu`) is therefore a single text file. To actually play the merged map, the user must have the same audio (and any referenced custom hitsounds/storyboard assets) locally in the matching beatmap folder. This is by design: this is a modding/collaboration tool, not a beatmap distribution platform, and `AudioFilename` is treated as a Critical setting precisely so all collaborators agree on which local file the `.osu` references.

### Base Template — Per-Upload Regeneration with Versioning

The base template is regenerated on **every** section upload, not just the first. We do this because mappers iterate on timing/metadata mid-collab, and a frozen first-upload base goes stale immediately. To keep history coherent and to detect incompatible changes, every base regeneration produces a new `DifficultyBaseOsuVersion` row with full version history (parallel to `SectionOsuVersion`).

#### What a base contains

For any uploaded `.osu`, the candidate base is computed by:
1. Keeping everything **before** `[HitObjects]` intact (headers, `[General]`, `[Metadata]`, `[Events]`, `[Difficulty]`, `[Colours]`, etc.).
2. In `[TimingPoints]`: keeping only lines with **positive `beatLength`** (uninherited / true BPM points). Discarding negative SV multipliers.
3. Leaving `[HitObjects]` empty.

#### Settings classification

When comparing a new candidate base against the currently active base, header lines are bucketed:

| Bucket | Lines | On mismatch (default) |
| :--- | :--- | :--- |
| **Critical** | All key/value lines in `[Difficulty]`; `AudioFilename` in `[General]` | **Reject the upload** with `409 Conflict`. Response body lists the conflicting keys with both values plus the uploader's role, so the frontend can show a role-aware modal. Nothing is written. The uploader either cancels or re-submits with `acknowledge_critical: true` — see "Acknowledged critical mismatch" below. **Only the mapset `owner` can permanently change critical settings.** |
| **Notice** | All other lines in `[General]`, `[Events]`, `[Metadata]` — **except `Version` in `[Metadata]`**, which mappers customize per-collaborator | Save a new `DifficultyBaseOsuVersion` (next version, `is_active = true`, previous active flipped to `false` in the same transaction). Section upload proceeds. The response includes a warning summarizing which keys changed. |
| **Ignored** | `[Metadata] Version` (collab convention); `[TimingPoints]` (positive lines are folded into the base via the candidate filter, the rest are merged at download time); `[Colours]` (cosmetic, last-write-wins on the base); `[Editor]` (per-mapper editor state — bookmarks, distance spacing, beat divisor — never authoritative across the collab) | No effect on the base unless the line falls into a bucket above. |

The positive `[TimingPoints]` content of the candidate base **is** compared against the active base — if BPM points changed, that's a notice-bucket update (it changes the base content but it's not user-facing settings).

#### Acknowledged critical mismatch

When the upload route is re-submitted with `acknowledge_critical: true` (request body field) after a `409`, the behavior depends on the uploader's role:

- **Owner:** treats the new file as authoritative. The base is regenerated with the new critical settings (new `DifficultyBaseOsuVersion`), and the section is saved as-is. The frontend should present this as a destructive confirmation: *"CRITICAL: are you sure? You're about to change `OverallDifficulty`, `AudioFilename`, … on the base. Every collaborator's section will use these settings going forward."*
- **Mapper:** the base wins. The backend rewrites the section's critical lines to match the active base's values **before** persisting the section version, and saves the rewritten file. The base is **not** changed. The frontend should present this as a non-destructive warning: *"Your diff's `OverallDifficulty`, `AudioFilename`, … differ from the base. Make sure you're uploading the correct difficulty. (Cancel) (I'm aware)"* — clicking "I'm aware" re-submits with the flag and the user accepts that their file's critical fields will be normalized.
- **Modder:** can't reach this code path; modders cannot upload `.osu` at all (`403`).

This split is deliberate. Owners are the only role with authority over critical mapset properties (difficulty, audio); mappers can iterate on their section's hit objects and timing details but not silently change the difficulty's identity.

#### Algorithm — on every section upload

1. Validate the file is well-formed (contains `[HitObjects]`) and ≤ 1 MB.
2. Parse and compute the candidate base.
3. **No active base for this difficulty (first upload):** in one transaction, insert the section version (`is_active = true`) **first** to obtain its id, then insert the candidate base as version 1 (`is_active = true`, `source_section_version_id = <new section version id>`).
4. **Active base exists** — diff candidate against active base:
   - **Critical mismatch and `acknowledge_critical` is not set** → `409` with the diff. Nothing is written.
   - **Critical mismatch with `acknowledge_critical: true`:**
     - Owner → in one transaction: deactivate prior section version, insert new section version (`is_active = true`); then deactivate prior base, insert new base version (`is_active = true`, `source_section_version_id = <new section version id>`). Section-first ordering is required because the new base's `source_section_version_id` FK must reference an existing row. Response is `200` with `warnings`.
     - Mapper → in one transaction: deactivate prior section version, insert new section version whose critical lines have been rewritten to match the active base. Base is untouched. Response is `200` with `warnings` listing which fields were normalized.
   - **Notice mismatch (or positive timing-point-line diff):** in one transaction, deactivate prior section version, insert new section version (`is_active = true`); then deactivate prior base, insert new base version (`is_active = true`, `source_section_version_id = <new section version id>`). Section-first for the same FK reason. Response is `200` with `warnings`.
   - **No diff:** in one transaction, deactivate prior section version, insert new section version. Base is untouched.

> **Insert order matters.** Whenever a base version is created, its `source_section_version_id` references the section version produced by the same upload. Insert the section version first, capture its id, then insert the base — otherwise the FK fails at INSERT time (the constraint is not deferred).
>
> The "single transaction" requirement is what makes the partial-unique-index DB constraints (Section 3) safe. Without it the index would fire mid-flight and abort the whole operation. With it, deactivate-then-activate is atomic.

### Concurrent uploads
Two simultaneous uploads to the same difficulty are not coordinated with an application-level lock. The partial unique indexes on `is_active` will reject the second commit (`IntegrityError`); the route should catch it and return `409` so the client can retry. We accept this trade-off because:
- The forum is private, with at most ~6 active collaborators per mapset.
- Two mappers uploading to the same difficulty within the same millisecond is vanishingly rare in practice.
- An advisory lock or queue would add complexity that pays back nothing in this size class.

If contests grow to dozens of concurrent collaborators per difficulty, revisit (PostgreSQL advisory locks per `difficulty_id` are the obvious next step).

### Version History & Rollback
All previous section uploads and base versions are preserved. Users can:
- List all section versions and all base versions with metadata (version number, uploader / source section version, timestamp, active status).
- Activate any previous section version (flips section `is_active` in a transaction). **Activating a previous section version does not retroactively change the base** — base history is independent and only advances on uploads.

### Merged Difficulty Download (`GET /difficulties/{did}/merged.osu`)
The backend assembles a complete, valid `.osu` file from the active base + every section's active version:

1. **Headers:** start with the active `DifficultyBaseOsuVersion.content` (everything before `[HitObjects]`). This is the authoritative source of `[General]`, `[Metadata]`, `[Events]`, `[Difficulty]`, `[Colours]`.
2. **Timing points:** collect lines from:
   - The active base (positive BPM points only).
   - Every section's active `.osu` file (all timing points — positive and negative).
3. **Sort & deduplicate:**
   - Sort by `time` (first column) ascending.
   - Deduplicate by (timestamp, type) where type is "positive" (`beatLength > 0`) or "negative" (`beatLength < 0`):
     - At most one positive line per timestamp.
     - At most one negative line per timestamp.
     - One positive + one negative at the same timestamp is allowed and preserved (this is how osu! encodes a BPM change with a custom SV at the same instant).
   - **Tiebreaker when two lines of the same type collide on the same timestamp:** section content overrides the base; among sections, the lower `Section.sort_order` wins (with `Section.id` as a stable secondary tiebreaker). This makes the merge deterministic and gives the earliest section authority over its own boundary.
4. **Hit objects:** collect `[HitObjects]` lines from every section's active version, sort ascending by `time` (third column).
5. **Assemble:** write headers → `[TimingPoints]` → `[HitObjects]`.

### Section Download (`GET /difficulties/{did}/sections/{sid}/osu`)
Returns the exact `.osu` file content of the currently active version for that section, byte-for-byte as uploaded. This lets a mapper edit the file in the osu! editor and re-upload.

### Bookmark Import (Optional Stretch)
As a convenience feature, users can optionally upload a `.osu` file to auto-generate `Section` records from `[Editor] Bookmarks:`. This is unchanged from the original spec but is now considered a Phase 7 stretch feature rather than part of core `.osu` management.

---

## 9. Docker & Local Development

### `docker-compose.yml`
The file will define three services:
1. **`db`**: `postgres:15-alpine` image. Exposes port `5432`. Uses a named volume for data persistence.
2. **`backend`**: Built from `./backend/Dockerfile`. Exposes port `8000`. Depends on `db`.
3. **`frontend`**: Built from `./frontend/Dockerfile`. In development, runs the Vite dev server on port `5173` (Vite's default). In production, the built static SPA is served via Nginx.

### Backend `Dockerfile`
- Use `python:3.12-slim` as the base image (modern, stable, better performance than 3.11).
- Install dependencies from `requirements.txt`.
- Copy the `app` directory.
- Run `uvicorn app.main:app --host 0.0.0.0 --port 8000`.

### Frontend `Dockerfile` (Production Serve)
- Use `node:20-alpine` to build the app (`npm install`, `npm run build`).
- Use `nginx:alpine` as the final stage.
- `COPY` the build output (`dist/`) to `/usr/share/nginx/html`.
- `COPY` `nginx.conf` to `/etc/nginx/nginx.conf` (SPA fallback to `index.html`, reverse-proxy `/api/*` to the `backend` container, SSL termination).
- Listens on `80` and `443`. This is the only nginx in the stack — there is no separate reverse-proxy layer.

### Environment Variables (`.env`)
The backend will read these via Pydantic Settings:
- `DATABASE_URL`: `postgresql+asyncpg://osu:osu@db:5432/modding`
- `OSU_CLIENT_ID`: From osu! OAuth app registration.
- `OSU_CLIENT_SECRET`: From osu! OAuth app registration.
- `SECRET_KEY`: Random string for JWT signing.
- `FRONTEND_URL`: `http://localhost:5173` (must match the Vite dev server port — used for CORS and OAuth redirect)
- `BACKEND_URL`: `http://localhost:8000`

---

## 10. Implementation Order (MVP)

A phased approach to keep the project testable and avoid large merge conflicts. Each task below is designed to be small (typically 50–300 lines of code), self-contained, and reviewable. **A sub-agent should receive one task at a time.** After each task, run `docker-compose up --build` to verify nothing is broken.

> **Testing Rule:** Every phase must include tests. Backend changes require passing unit/integration tests. Frontend changes require passing component tests. See Section 13 for test setup requirements.

---

### Phase 1: Foundation, Auth, & Test Setup

| # | Task | What It Produces | Verification |
|---|------|------------------|------------|
| 1.1 | Initialize monorepo structure | `docker-compose.yml`, `backend/`, `frontend/` directory skeleton | `tree` shows expected layout |
| 1.2 | Set up PostgreSQL in Docker Compose | `docker-compose.yml` with `db` service, healthcheck | `docker-compose up db` succeeds |
| 1.3 | Set up FastAPI backend boilerplate | `backend/requirements.txt`, `backend/app/main.py`, `backend/Dockerfile` | `docker-compose up backend` starts without error |
| 1.4 | Set up SQLModel + database connection | `backend/app/database.py`, `backend/app/config.py` | Can connect to DB from backend container |
| 1.5 | Set up Alembic | `alembic.ini`, `alembic/` directory | `docker-compose exec backend alembic upgrade head` works |
| 1.6 | Set up backend testing framework | `pytest`, `pytest-asyncio`, `httpx` in `requirements.txt`, `backend/tests/` directory, `conftest.py` with async DB fixture | `docker-compose exec backend pytest` runs and passes (zero tests) |
| 1.7 | Create `User` model + migration | `backend/app/models.py` with `User` table | Migration succeeds; can create/read `User` in test |
| 1.8 | Implement osu! OAuth routes (init + callback) | `backend/app/routers/auth.py`, `backend/app/services/auth_service.py` | Can initiate OAuth flow locally; write integration test mocking osu! API |
| 1.9 | Implement `/auth/me` and `/auth/logout` | JWT cookie verification, `get_current_user` dependency | Cookie-based auth works end-to-end; write tests for protected routes |
| 1.10 | Set up React + Vite + Tailwind | `frontend/package.json`, `vite.config.ts`, `tailwind.config.js`, `src/index.css` | `npm run dev` starts, Tailwind classes work |
| 1.11 | Set up frontend testing framework | `vitest`, `@testing-library/react`, `jsdom` in `package.json`, `src/test/setup.ts` | `npm test` runs and passes (zero tests) |
| 1.12 | Set up React Router + basic pages | `src/App.tsx`, `src/pages/LoginPage.tsx`, `src/pages/DashboardPage.tsx` | Navigation between `/login` and `/dashboard` works |
| 1.13 | Implement auth state management | `src/hooks/useAuth.ts`, `src/api/client.ts`, `src/api/endpoints.ts` | Login/logout toggles UI state; write test for `useAuth` hook |
| 1.14 | Build Login page UI | `src/pages/LoginPage.tsx` with "Login with osu!" button | Clicking button redirects to osu! OAuth |

**Deliverable:** A user can log in with osu! and see their username on the frontend. All tests pass. `docker-compose up --build` succeeds.

---

### Phase 2: Mapset Management

| # | Task | What It Produces | Verification |
|---|------|------------------|------------|
| 2.1 | Create `Mapset` and `MapsetMember` models + migration | Update `models.py` | DB schema matches spec; write model unit tests |
| 2.2 | Implement `POST /mapsets` | Create mapset + auto-add owner as `MapsetMember` | Can create mapset via API; write integration test |
| 2.3 | Implement `GET /mapsets` | List mapsets for current user | Returns only user's mapsets; write test |
| 2.4 | Implement `GET /mapsets/{id}` | Full mapset details | Returns 403 for non-members; write test |
| 2.5 | Implement `PUT /mapsets/{id}` + `DELETE /mapsets/{id}` | Update/delete with role checks | Only owner/mapper can update; only owner can delete; write tests |
| 2.6 | Build Dashboard page | `src/pages/DashboardPage.tsx` + `src/components/MapsetCard.tsx` | Lists user's mapsets; write component test |
| 2.7 | Build "Create Mapset" form | Modal/form with name, description, song length | Creates mapset, appears on dashboard; write component test |

**Deliverable:** A user can create a mapset and see it on their dashboard. All tests pass.

---

### Phase 3: Difficulties, Sections, & `.osu` Upload

| # | Task | What It Produces | Verification |
|---|------|------------------|------------|
| 3.1 | Create `Difficulty`, `Section`, `SectionOsuVersion`, `DifficultyBaseOsuVersion` models + migration (incl. partial unique indexes on `is_active`) | Update `models.py` | DB schema matches spec; partial unique indexes prevent two `is_active = true` rows per section/difficulty; write model tests |
| 3.2 | Implement Difficulty CRUD routes | `POST/GET/PUT/DELETE` for difficulties | Full CRUD works via API; write integration tests |
| 3.3 | Implement Section CRUD routes | `POST/PUT/DELETE` for sections | Sections scoped to difficulty; write tests |
| 3.4 | Build Difficulty Tabs UI | `src/components/DifficultyTabs.tsx` | Switching difficulties updates view; write component test |
| 3.5 | Build Section Sidebar UI | `src/components/SectionList.tsx` | Sections display per difficulty; write component test |
| 3.6 | Implement `.osu` upload for sections | `POST /difficulties/{did}/sections/{sid}/osu` | Upload succeeds, content stored; write integration test |
| 3.7 | Implement base template generation + per-upload regen | Compute candidate base on every upload, diff against active `DifficultyBaseOsuVersion` (critical/notice/ignored buckets, plus `acknowledge_critical` ack flow per Section 8), insert new base version when needed | Base v1 created on first upload; subsequent uploads with notice diffs create v2/v3 with warnings; critical mismatch returns `409`; ack flow regens base for owner, normalizes section for mapper. Unit test the parser + bucket classification; integration test all four branches of the algorithm. |
| 3.8 | Implement section `.osu` download | `GET /difficulties/{did}/sections/{sid}/osu` | Returns exact uploaded file; write test |
| 3.9 | Add `.osu` upload/download UI | `OsuUploadButton`, download button in Section Sidebar | File picker works, download returns correct content; write component tests |
| 3.10 | Implement section version history endpoints | `GET /difficulties/{did}/sections/{sid}/osu/versions`, `POST .../activate` | Can list section versions and roll back atomically; write tests for the active-version invariant |
| 3.11 | Implement base version history endpoints | `GET /difficulties/{did}/base/versions`, `POST /difficulties/{did}/base/versions/{vid}/activate` | Can list base versions and roll back atomically; write tests for the active-version invariant. Activation must run in one transaction. |
| 3.12 | Add section version history UI | `OsuVersionHistory` modal | Can view section history and switch versions; write component test |
| 3.13 | Add base version history UI | `BaseVersionHistory` modal in the difficulty header (next to "Download Base Template") | Lists base versions with their `source_section_version_id` so users can see which section upload triggered each base change; activate any prior version; write component test |
| 3.14 | Add critical-ack upload flow UI | Frontend handler for `409` from section upload that branches on the user's role: owner sees a destructive "CRITICAL: Are you sure?" modal listing the changed keys; mapper sees a "your diff differs from the base, (Cancel) (I'm aware)" modal; both retry the upload with `acknowledge_critical: true` on confirm | Both modals render correctly; "I'm aware" path produces an upload whose stored content has critical lines normalized to base values; write component tests for both branches |

**Deliverable:** Users can create difficulties and sections, upload `.osu` files per section, download them back, and manage versions. All tests pass.

---

### Phase 4: Forum Posts

| # | Task | What It Produces | Verification |
|---|------|------------------|------------|
| 4.1 | Create `Post` model + migration | Update `models.py` | DB schema matches spec; write model test |
| 4.2 | Implement Post CRUD routes | `POST/PUT/DELETE` for posts | Author-only edit, author/owner delete; write tests |
| 4.3 | Implement post listing | Posts returned with difficulty details | Chronological order; write test |
| 4.4 | Build `PostCard` component | Avatar, tag badge, content display | Renders correctly; write component test |
| 4.5 | Build `CreatePostForm` component | Textarea, tag selector | Creates post via API; write component test |
| 4.6 | Render forum thread | Posts list in Mapset View | Posts display per difficulty; write integration test |

**Deliverable:** Users can leave general comments on a specific difficulty. All tests pass.

---

### Phase 5: Timestamps & Merged Difficulty Download

| # | Task | What It Produces | Verification |
|---|------|------------------|------------|
| 5.1 | Implement timestamp extraction logic | `backend/app/services/osu_parser.py` | Regex extracts first timestamp + combos correctly; write unit test |
| 5.2 | Integrate extraction into post create/update | Auto-populate `timestamp_ms` and `hit_object_combos` | DB columns updated on post save; write integration test |
| 5.3 | Update `PostCard` with `osu://` links | `generateOsuLink` function, clickable primary timestamp | Link opens osu! client; write component test |
| 5.4 | Linkify all timestamps in post content | Frontend regex to find additional timestamps | All timestamps in body are clickable; write component test |
| 5.5 | Add timeline scrubber markers | Dots on timeline for posts with timestamps | Visual markers appear; write component test |
| 5.6 | Implement merged `.osu` download | `GET /difficulties/{did}/merged.osu` | Combines base + all sections' hit objects + deduped timing points; write integration test with sample .osu files |
| 5.7 | Add merged download UI | "Download Full Difficulty" button in header | Downloads valid .osu file; write component test |

**Deliverable:** Clicking a timestamp opens the osu! editor. Users can download a fully merged difficulty. All tests pass.

---

### Phase 6: Editing & Members

| # | Task | What It Produces | Verification |
|---|------|------------------|------------|
| 6.1 | Implement post editing (`PUT`) | `PUT /difficulties/{did}/posts/{pid}` | Author can edit, timestamp re-extracted; write test |
| 6.2 | Add "Edit" button to `PostCard` | Conditional rendering | Only author sees edit button; write component test |
| 6.3 | Implement member invitation | `POST /mapsets/{id}/members` | Resolve username to user_id; write integration test |
| 6.4 | Implement member removal + role change | `DELETE /mapsets/{id}/members/{user_id}` and `PUT /mapsets/{id}/members/{user_id}` | Owner-only; ownership-transfer atomicity; self-demotion is rejected; write tests for all edge cases (Section 4) |
| 6.5 | Add "Manage Members" UI | Invite/remove members modal | Functional member management; write component test |

**Deliverable:** Users can edit posts and invite collaborators. All tests pass.

---

### Phase 7: Polish, Bookmark Import, & Final Testing

| # | Task | What It Produces | Verification |
|---|------|------------------|------------|
| 7.1 | Implement bookmark import (stretch) | Parse `[Editor] Bookmarks:` from `.osu` upload to auto-create sections | Creates sections correctly; write parser unit test |
| 7.2 | Add loading states & error handling | Spinners, toast notifications | UX feels responsive; write component tests |
| 7.3 | Run full test suite | All backend and frontend tests | `pytest` and `npm test` pass; coverage reflects "everything that matters" per Section 11, not a numeric threshold |
| 7.4 | Final Docker Compose testing | All services start cleanly | `docker-compose up --build` works end-to-end |
| 7.5 | Update deployment docs | Reflect any final env vars or config changes | Docs are accurate |

**Deliverable:** A fully functional MVP, containerized, tested, and ready for deployment.

---

## 11. Testing Strategy

Testing is not optional. Every task in Section 10 must include tests. This ensures that sub-agents produce verifiable, correct code and prevents regressions as the codebase grows.

### Backend Tests (pytest)

**Frameworks:** `pytest`, `pytest-asyncio`, `httpx` (for async FastAPI testing).

**Test Structure:**
```
backend/tests/
├── conftest.py          # Shared fixtures: async DB engine, test client, mock user
├── test_auth.py         # OAuth flow, JWT cookies, /auth/me
├── test_mapsets.py      # Mapset CRUD, permissions
├── test_difficulties.py # Difficulty CRUD, .osu upload/download/merge
├── test_sections.py     # Section CRUD
├── test_posts.py        # Post CRUD, timestamp extraction
├── test_members.py      # Member invitation, permissions
└── services/
    └── test_osu_parser.py  # Timestamp regex, .osu merge logic, base template generation
```

**Key Fixtures (conftest.py):**
- `db_session`: Async SQLModel session connected to a **dedicated PostgreSQL test container** (separate from the dev `db` service, with its own volume). We do not test against SQLite — the production driver (`asyncpg`) and Postgres-specific behavior (`selectinload`, partial unique indexes, `ENUM` types, JSON columns, deferrable constraints, dialect quirks) must be exercised in tests, not papered over.
- `client`: `httpx.AsyncClient` mounted to the FastAPI app.
- `mock_user`: A pre-authenticated `User` object injected into `get_current_user` dependency for tests.
- `mock_osu_file`: Sample `.osu` file content for parser tests.

**Testing Rules:**
- Every API endpoint must have at least one integration test.
- Every service function (parser, merger) must have unit tests covering normal cases and edge cases.
- Permission checks must be tested explicitly (e.g., a `modder` cannot upload `.osu`).

### Frontend Tests (Vitest + React Testing Library)

**Frameworks:** `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`.

**Test Structure:**
```
frontend/src/
├── test/
│   └── setup.ts           # Vitest setup, mock global fetch
├── api/
│   └── endpoints.test.ts  # API function mocks
├── hooks/
│   └── useAuth.test.ts    # Auth state logic
├── components/
│   ├── MapsetCard.test.tsx
│   ├── PostCard.test.tsx
│   ├── CreatePostForm.test.tsx
│   ├── OsuUploadButton.test.tsx
│   └── OsuVersionHistory.test.tsx
└── pages/
    ├── LoginPage.test.tsx
    └── DashboardPage.test.tsx
```

**Testing Rules:**
- Every component must have a render test ("does it mount without crashing?").
- Every interactive component must have a user-event test ("does clicking X do Y?").
- Every hook must have a logic test.
- Mock API calls; do not hit the real backend in frontend tests.

### Docker Compose Testing

After every task (or group of related tasks), run:
```bash
docker-compose down -v          # Clean state
docker-compose up --build -d    # Build and start
docker-compose exec backend alembic upgrade head
docker-compose exec backend pytest
docker-compose exec frontend npm test
```

If any step fails, the task is not complete.

---

## 12. Deployment Strategy

The architecture is designed for maximum flexibility:

- **Local Development:** `docker-compose up`.
- **Cheap VPS (e.g., Hetzner, DigitalOcean):**
  - Clone the repo (or just write `docker-compose.prod.yml`) on the server.
  - Create a `.env` file with production secrets.
  - Run `docker-compose -f docker-compose.prod.yml up -d`.
  - SSL termination is handled by the frontend image's own nginx (see Section 13.5). There is no extra reverse-proxy layer in front of it; certificates are bind-mounted from the host.
- **Split Services:**
  - **Frontend:** Easily deployed to Vercel or Netlify (it's a static SPA).
  - **Backend + DB:** Deployed to Railway, Render, or Fly.io.
  - **Database:** Use the free tier of Supabase PostgreSQL if preferred, simply by changing the `DATABASE_URL`.

Because everything is in Docker, moving from local to any host is trivial.

---

## 13. Deployment Guide

This section provides step-by-step instructions for running the application in both local development and production environments.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)
- A registered osu! OAuth application ([create one here](https://osu.ppy.sh/home/account/edit#oauth))

### Registering an osu! OAuth Application

1. Go to your osu! account settings and navigate to the **OAuth** section.
2. Click **"New OAuth Application"**.
3. Fill in the details:
   - **Name:** `osu-modding-forum` (or whatever you prefer)
   - **Redirect URI:** `http://localhost:8000/api/auth/osu/callback` (for local) or `https://yourdomain.com/api/auth/osu/callback` (for production)
4. Save the application.
5. Copy the **Client ID** and **Client Secret** — you will need them for the `.env` file.

---

### Local Deployment (Docker Compose)

This method builds the images directly from the source code. Ideal for development and testing.

#### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/osu-modding-forum.git
cd osu-modding-forum
```

#### 2. Create the Environment File

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Edit `.env` with your osu! credentials:

```env
# Database
DATABASE_URL=postgresql+asyncpg://osu:osu@db:5432/modding

# osu! OAuth
OSU_CLIENT_ID=your_osu_client_id_here
OSU_CLIENT_SECRET=your_osu_client_secret_here

# Security
SECRET_KEY=your_super_secret_random_string_here

# URLs (for local development)
FRONTEND_URL=http://localhost:5173
BACKEND_URL=http://localhost:8000
```

> **Note on ports:** the Vite dev server runs on `5173` in development. `FRONTEND_URL` must match this exactly — it is used both for CORS allow-list and for the post-OAuth redirect. In production, the frontend nginx listens on `80` (or `443` with SSL) and `FRONTEND_URL` is the public domain.

> **Tip:** Generate a strong `SECRET_KEY` with: `openssl rand -hex 32`

#### 3. Build and Run

```bash
docker-compose up --build
```

This will:
- Start PostgreSQL on port `5432`
- Build and start the FastAPI backend on port `8000`
- Build and start the React frontend (Vite dev server) on port `5173`

#### 4. Run Database Migrations

On first run (and after any schema changes), apply migrations:

```bash
docker-compose exec backend alembic upgrade head
```

#### 5. Access the Application

- **Frontend:** http://localhost:5173
- **Backend API:** http://localhost:8000/api
- **API Docs (Swagger UI):** http://localhost:8000/api/docs

#### 6. Stopping the Services

```bash
# Stop gracefully
docker-compose down

# Stop and remove all data (including the database volume)
docker-compose down -v
```

#### 7. Updating After Code Changes

Since we use volume mounts for local development, frontend changes will hot-reload automatically. For backend changes, restart the container:

```bash
docker-compose restart backend
```

If you add new Python dependencies, rebuild:

```bash
docker-compose up --build
```

---

### Production Deployment (DockerHub Images)

This method uses pre-built images published to DockerHub. This is the recommended approach for production servers.

#### 1. Prepare Your Server

Provision a VPS (e.g., Hetzner, DigitalOcean, Linode) with Docker and Docker Compose installed.

#### 2. Create a Deployment Directory

On your server, create a folder for the deployment files:

```bash
mkdir ~/osu-modding-forum
cd ~/osu-modding-forum
```

#### 3. Create `docker-compose.prod.yml`

Create a `docker-compose.prod.yml` file. This file **does not build from source**; it pulls images from DockerHub:

```yaml
version: "3.8"

services:
  db:
    image: postgres:15-alpine
    container_name: osu-modding-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: osu
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: modding
    volumes:
      - db_data:/var/lib/postgresql/data
    networks:
      - osu-modding-network

  backend:
    image: yourdockerhubuser/osu-modding-backend:latest
    container_name: osu-modding-backend
    restart: unless-stopped
    ports:
      - "127.0.0.1:8000:8000"
    environment:
      DATABASE_URL: postgresql+asyncpg://osu:${DB_PASSWORD}@db:5432/modding
      OSU_CLIENT_ID: ${OSU_CLIENT_ID}
      OSU_CLIENT_SECRET: ${OSU_CLIENT_SECRET}
      SECRET_KEY: ${SECRET_KEY}
      FRONTEND_URL: ${FRONTEND_URL}
      BACKEND_URL: ${BACKEND_URL}
    depends_on:
      - db
    networks:
      - osu-modding-network

  frontend:
    image: yourdockerhubuser/osu-modding-frontend:latest
    container_name: osu-modding-frontend
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./certbot/conf:/etc/letsencrypt:ro
      - ./certbot/www:/var/www/certbot:ro
    depends_on:
      - backend
    networks:
      - osu-modding-network

volumes:
  db_data:

networks:
  osu-modding-network:
    driver: bridge
```

#### 4. Create the `.env` File

```bash
touch .env
```

Add your production secrets:

```env
# Database
DB_PASSWORD=your_strong_postgres_password_here

# osu! OAuth
OSU_CLIENT_ID=your_osu_client_id_here
OSU_CLIENT_SECRET=your_osu_client_secret_here

# Security
SECRET_KEY=your_super_secret_random_string_here

# URLs (Production)
FRONTEND_URL=https://yourdomain.com
BACKEND_URL=https://yourdomain.com
```

> **Important:** In production, set your osu! OAuth **Redirect URI** to `https://yourdomain.com/api/auth/osu/callback`.

#### 5. Configure Nginx

The frontend image is the public-facing nginx — it serves the built SPA from `/usr/share/nginx/html`, terminates SSL, and reverse-proxies `/api/*` to the `backend` container. There is no separate nginx layer.

Create `nginx/nginx.conf`:

```nginx
events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    server {
        listen 80;
        server_name yourdomain.com;

        location /.well-known/acme-challenge/ {
            root /var/www/certbot;
        }

        location / {
            return 301 https://$host$request_uri;
        }
    }

    server {
        listen 443 ssl;
        server_name yourdomain.com;

        ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

        # Static SPA: serve dist; SPA routing falls back to index.html
        root /usr/share/nginx/html;
        index index.html;

        location / {
            try_files $uri $uri/ /index.html;
        }

        location /api/ {
            # No trailing slash on proxy_pass: backend natively serves under /api/.
            proxy_pass http://backend:8000;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }
    }
}
```

> **One nginx, two locations for the same config.** The stack has a single nginx process — the one inside the frontend image. The `nginx.conf` exists in two places only as a deployment convenience:
>
> - **In the repo** at `frontend/nginx.conf` — `COPY`d into the image at build time so the published image is self-contained and works out of the box.
> - **On the deploy server** at `~/osu-modding-forum/nginx/nginx.conf` — bind-mounted *over* the image's copy at runtime via the `volumes:` entry above. This lets ops edit `server_name`, SSL cert paths, etc. without rebuilding the image.
>
> Both files contain the same nginx configuration. There is no second nginx, no separate reverse-proxy layer, no inner static-file server.

#### 6. Obtain SSL Certificates (Let's Encrypt)

```bash
docker run -it --rm \
  -v $(pwd)/certbot/conf:/etc/letsencrypt \
  -v $(pwd)/certbot/www:/var/www/certbot \
  certbot/certbot certonly \
  --standalone \
  --agree-tos \
  --no-eff-email \
  --email your-email@example.com \
  -d yourdomain.com
```

#### 7. Start the Application

```bash
docker-compose -f docker-compose.prod.yml pull
docker-compose -f docker-compose.prod.yml up -d
```

#### 8. Run Database Migrations

```bash
docker-compose -f docker-compose.prod.yml exec backend alembic upgrade head
```

#### 9. Verify

- **Frontend:** https://yourdomain.com
- **API:** https://yourdomain.com/api
- **API Docs:** https://yourdomain.com/api/docs

#### 10. Updating to New Versions

When you publish new images to DockerHub:

```bash
# Pull latest images
docker-compose -f docker-compose.prod.yml pull

# Restart with new images
docker-compose -f docker-compose.prod.yml up -d

# Run migrations if needed
docker-compose -f docker-compose.prod.yml exec backend alembic upgrade head
```

To automate updates, you can set up a simple CI/CD pipeline or use [Watchtower](https://containrrr.dev/watchtower/):

```bash
docker run -d \
  --name watchtower \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower \
  --interval 3600 \
  osu-modding-backend osu-modding-frontend
```

---

### Environment Variables Reference

| Variable | Required | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | Yes | PostgreSQL connection string. Format: `postgresql+asyncpg://user:pass@host:port/db` |
| `OSU_CLIENT_ID` | Yes | Your osu! OAuth application Client ID. |
| `OSU_CLIENT_SECRET` | Yes | Your osu! OAuth application Client Secret. |
| `SECRET_KEY` | Yes | A random secret string used to sign JWT tokens. |
| `FRONTEND_URL` | Yes | The public URL of the frontend (e.g., `http://localhost:5173` in dev, `https://yourdomain.com` in prod). Used for CORS allow-list and the post-OAuth redirect — must match exactly. |
| `BACKEND_URL` | Yes | The public URL of the backend (e.g., `http://localhost:8000` or `https://yourdomain.com`). |
| `DB_PASSWORD` | Yes (prod) | PostgreSQL root password (used in `docker-compose.prod.yml`). |
| `ACCESS_TOKEN_TTL_DAYS` | No | Default `14`. Lifetime of the `access_token` JWT/cookie in days. Picked to outlast typical contest cycles (15+ days); set lower if your threat model demands shorter sessions, or higher for trusted internal collabs. |

---

### Troubleshooting

| Issue | Solution |
| :--- | :--- |
| `alembic upgrade head` fails with connection error | Ensure the `db` service is healthy and running before executing migrations. |
| osu! OAuth callback fails | Double-check that `OSU_CLIENT_ID`, `OSU_CLIENT_SECRET`, and `BACKEND_URL` match your osu! OAuth app settings exactly. |
| Frontend shows blank page | Check browser console for CORS errors. Ensure `FRONTEND_URL` and `BACKEND_URL` are set correctly. |
| Images not updating | Run `docker-compose pull` to fetch the latest images from DockerHub before `docker-compose up -d`. |
| Database data lost after `docker-compose down` | Only use `docker-compose down -v` if you intentionally want to wipe data. Otherwise, omit the `-v` flag. |
