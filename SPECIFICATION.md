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
│       │   # NOTE: osu_parser.py is REMOVED — all .osu processing is client-side.
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
| `id` | `UUID` | PK, default `gen_random_uuid()` | Internal ID. **Server-generated exception:** `User` is created during the OAuth callback before any client crypto context exists, and `User` has no encrypted fields, so AAD bootstrapping does not apply. Every other table uses client-generated UUIDv4.
| `osu_id` | `Integer` | Unique, NOT NULL | The numeric ID from the osu! API. **Immutable** — this is the stable identifier for the human; `username` and `avatar_url` are display fields and may change. (`UNIQUE` already creates an index in PostgreSQL, no separate `Index` declaration needed.) |
| `username` | `String` | | osu! username. Refreshed from `/api/v2/me` on every login. |
| `avatar_url` | `String` | | URL to the user's avatar image. Refreshed on every login. |
| `created_at` | `DateTime` | Default: `func.now()` | First-login timestamp. |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | Last time `username`/`avatar_url` were refreshed (or any other column changed). |

### `Mapset` (Renamed from `Project`)
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | PK, client-generated | The client generates a UUIDv4 before encrypting and includes it in the AAD. This solves the AAD bootstrapping problem: the row identity is known before INSERT. |
| `title` | `String(255)` | NOT NULL | **Plaintext** mapset title. Visible on the dashboard and in invitation links so users can distinguish between multiple mapsets without unlocking them. |
| `encrypted_description` | `Text` | Nullable | AES-256-GCM ciphertext of the optional mapset description. |
| `encrypted_song_length_ms` | `Text` | NOT NULL | AES-256-GCM ciphertext of the audio length in milliseconds (versioned JSON envelope `{"v":1,"ms":245000}`). The `v` field provides a schema version so future readers can distinguish formats; `ms` is the integer length in milliseconds. Used to render the timeline scrubber after decryption. |
| `passphrase_salt` | `String` | NOT NULL | 16-byte random salt (base64-encoded) for PBKDF2 key derivation. Public by design. |
| `encrypted_verification` | `Text` | NOT NULL | AES-256-GCM ciphertext of a fixed canary string (e.g. "verified"). Used by the frontend to confirm a passphrase is correct without decrypting real content. Harmless without the key, but because it's a known-plaintext canary, user-chosen passphrases are forbidden — the auto-generated 48-char passphrase provides sufficient entropy to resist offline brute-force. |
| `owner_id` | `UUID` | FK -> `User.id`, ondelete="RESTRICT" | Creator of the mapset. RESTRICT prevents deleting a `User` who still owns mapsets — they must first transfer ownership (`PUT /mapsets/{id}/members/{user_id}`). |
| `created_at` | `DateTime` | Default: `func.now()` | |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | |

### `MapsetMember` (Renamed from `ProjectMember`)
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | PK, client-generated | |
| `mapset_id` | `UUID` | FK -> `Mapset.id`, ondelete="CASCADE" | Membership rows die with the mapset. |
| `user_id` | `UUID` | FK -> `User.id`, ondelete="CASCADE" | If a user is deleted (no endpoint today, but FK semantics matter), their memberships go with them. |
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
| `id` | `UUID` | PK, client-generated | |
| `mapset_id` | `UUID` | FK -> `Mapset.id`, ondelete="CASCADE" | Difficulties die with the mapset. |
| `encrypted_name` | `Text` | NOT NULL | AES-256-GCM ciphertext of the difficulty name (e.g., "Easy", "Normal", "Hard", "Insane"). |
| `created_at` | `DateTime` | Default: `func.now()` | |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | |

> The base template (headers + positive BPM timing points + empty hit objects) is **not** stored on `Difficulty`. It lives in `DifficultyBaseOsuVersion` (see below) so we can keep version history of the base, the same way we do for sections.

### `DifficultyBaseOsuVersion`
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | PK, client-generated | |
| `difficulty_id` | `UUID` | FK -> `Difficulty.id`, ondelete="CASCADE" | |
| `encrypted_content` | `Text` | NOT NULL | AES-256-GCM ciphertext of the base template content: headers + filtered timing points + empty `[HitObjects]`. |
| `version` | `Integer` | | Incremental version number per difficulty. |
| `is_active` | `Boolean` | Default: `false` | Exactly one active version per difficulty. Enforced by partial unique index `WHERE is_active = true`. |
| `source_section_version_id` | `UUID` | FK -> `SectionOsuVersion.id`, Nullable, ondelete="SET NULL" | The section upload that produced this base version (for traceability). If the source section version is deleted (only happens when the section itself is deleted), keep the base version row but blank the pointer — base history must outlive its triggers. |
| `created_at` | `DateTime` | Default: `func.now()` | |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | Tracks the last `is_active` flip. The row's `encrypted_content` is immutable. |

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
| `id` | `UUID` | PK, client-generated | |
| `difficulty_id` | `UUID` | FK -> `Difficulty.id`, ondelete="CASCADE" | Each difficulty has its own independent sections; sections die with their difficulty. |
| `encrypted_name` | `Text` | NOT NULL | AES-256-GCM ciphertext of the section label (e.g., "Intro", "Kiai 1"). |
| `encrypted_start_time_ms` | `Text` | NOT NULL | AES-256-GCM ciphertext of the section start time in milliseconds (JSON envelope `{"v":0}`). |
| `encrypted_end_time_ms` | `Text` | NOT NULL | AES-256-GCM ciphertext of the section end time in milliseconds (JSON envelope `{"v":0}`). |
| `encrypted_sort_order` | `Text` | NOT NULL | AES-256-GCM ciphertext of the sort order (JSON envelope `{"v":0}`). |
| `created_at` | `DateTime` | Default: `func.now()` | |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | |

### `SectionOsuVersion`
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | PK, client-generated | |
| `section_id` | `UUID` | FK -> `Section.id`, ondelete="CASCADE" | |
| `encrypted_content` | `Text` | NOT NULL | AES-256-GCM ciphertext of the full .osu file content as uploaded. |
| `version` | `Integer` | | Incremental version number per section. |
| `is_active` | `Boolean` | Default: `false` | Only one version per section should be active. |
| `uploaded_by` | `UUID` | FK -> `User.id`, ondelete="RESTRICT" | The user who uploaded this version. RESTRICT preserves the audit trail — a `User` cannot be deleted while they have uploaded versions on record. |
| `created_at` | `DateTime` | Default: `func.now()` | |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | Tracks the last `is_active` flip. The row's `encrypted_content` is immutable. |

**Active version:** A section's currently active `.osu` version is the `SectionOsuVersion` row with `is_active = true` for that `section_id`. There is exactly one active version per section at any time. We deliberately do **not** denormalize this onto `Section` (e.g., `active_osu_version_id`) to avoid a circular foreign-key dependency between the two tables and to keep a single source of truth.

### `Post`
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | PK, client-generated | |
| `difficulty_id` | `UUID` | FK -> `Difficulty.id`, ondelete="CASCADE" | The difficulty this post is associated with; posts die with their difficulty. |
| `author_id` | `UUID` | FK -> `User.id`, ondelete="RESTRICT" | RESTRICT preserves the audit trail — a `User` cannot be deleted while they have authored posts. |
| `parent_id` | `UUID` | FK -> `Post.id`, Nullable, ondelete="CASCADE" | If set, this post is a reply to another post. Top-level posts are `NULL`. Deleting a parent cascades to all its replies. |
| `tag` | `PostTag` (PG enum) | NOT NULL | PostgreSQL `ENUM('general', 'suggestion', 'problem', 'praise')`. Same rationale as `MapsetMember.role`: typo-proof at write time. |
| `encrypted_body` | `Text` | NOT NULL | AES-256-GCM ciphertext of the full modding post body. |
| `created_at` | `DateTime` | Default: `func.now()` | |
| `updated_at` | `DateTime` | Default: `func.now()`, onupdate | |

**Section grouping is computed, not stored.** A post is attached only to a difficulty. Which `Section` a post belongs to is derived on the frontend by checking whether the post's extracted timestamp (computed from decrypted `encrypted_body`) falls within a section's decrypted `[start_time_ms, end_time_ms]` range. Posts with no extracted timestamp are shown as "General" for that difficulty. This way, rearranging or renaming sections is a pure frontend recompute — no database migration or post updates needed.

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
| `POST` | `/mapsets` | Any logged-in user | Create a new mapset. Payload: `{ title, encrypted_description, encrypted_song_length_ms, passphrase_salt, encrypted_verification }`. The frontend auto-generates a 48-character alphanumeric passphrase, derives the AES key via PBKDF2, and encrypts all content fields **except `title`** before sending. Automatically adds the creator as an `owner` in `MapsetMember`. |
| `GET` | `/mapsets` | Any logged-in user | List all mapsets where the current user is a member (via `MapsetMember`). The title is plaintext; other content fields are encrypted ciphertext. |
| `GET` | `/mapsets/{id}` | Any member | Get full mapset details, including all `Difficulty`s. Returns `403` if the user is not a member. All content fields are encrypted ciphertext. |
| `PUT` | `/mapsets/{id}` | Owner/Mapper | Update mapset. Payload may contain `title` (plaintext) and encrypted fields (e.g., `encrypted_description`). The backend stores them verbatim without inspection. |
| `DELETE` | `/mapsets/{id}` | Owner | Delete a mapset and all related data. |

### Difficulties (`/mapsets/{id}/difficulties`)
| Method | Route | Who | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/mapsets/{id}/difficulties` | Owner/Mapper | Create a new difficulty. Payload: `{ encrypted_name }`. |
| `GET` | `/mapsets/{id}/difficulties` | Any member | List all difficulties for this mapset. Returns encrypted names. |
| `GET` | `/difficulties/{did}` | Any member | Get a single difficulty with all its `Section`s and `Post`s. All content fields are encrypted ciphertext. |
| `PUT` | `/difficulties/{did}` | Owner/Mapper | Rename a difficulty. Payload: `{ encrypted_name }`. |
| `DELETE` | `/difficulties/{did}` | Owner/Mapper | Delete a difficulty and all its sections/posts. |

### Sections (`/difficulties/{did}/sections`)
| Method | Route | Who | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/difficulties/{did}/sections` | Owner/Mapper | Create a new section. Payload: `{ encrypted_name, encrypted_start_time_ms, encrypted_end_time_ms, encrypted_sort_order }`. |
| `PUT` | `/difficulties/{did}/sections/{sid}` | Owner/Mapper | Update section details. Payload contains encrypted fields. |
| `DELETE` | `/difficulties/{did}/sections/{sid}` | Owner/Mapper | Remove a section. Posts are unaffected (they're attached to the difficulty, not the section). |

### Posts (`/difficulties/{did}/posts`)
| Method | Route | Who | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/difficulties/{did}/posts` | Any member | Create a new post. Payload: `{ tag, encrypted_body, parent_id? }`. `parent_id` references an existing post in the same difficulty. The frontend extracts the first timestamp from the plaintext body **before encrypting**, for use in `osu://` link generation and timeline placement. The backend stores the ciphertext verbatim and never sees the plaintext. |
| `PUT` | `/difficulties/{did}/posts/{pid}` | Author only | Edit an existing post. Only the original `author_id` is permitted. Payload: `{ encrypted_body }`. The backend replaces the ciphertext verbatim. |
| `DELETE` | `/difficulties/{did}/posts/{pid}` | Author or Owner | Delete a post. If the post has replies, they are also deleted (DB-level cascade). The original `author_id` or the mapset `owner`. |

### Members (`/mapsets/{id}/members`)
| Method | Route | Who | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/mapsets/{id}/members` | Any member | List all members of the mapset. Returns each `MapsetMember` joined with its `User` (username, avatar_url, osu_id) plus `role` and `created_at`. This is the explicit endpoint the "Manage Members" UI consumes; `GET /mapsets/{id}` returns the mapset with its difficulties but not the member roster, so don't conflate the two. |
| `POST` | `/mapsets/{id}/members` | Owner | Add a member. Body: `{ "username": string }`. Backend resolves the username **only against the local `User` table** — the prospective member must have logged into the forum at least once. Returns `404` if the username is unknown, `409` if they're already a member. Creates a `MapsetMember` row with role `modder` (default). |
| `PUT` | `/mapsets/{id}/members/{user_id}` | Owner | Change a member's role. Body: `{ "role": "owner" \| "mapper" \| "modder" }`. Path param is `User.id`. Setting another member to `owner` **transfers ownership**: the previous owner is automatically demoted to `mapper` in the same transaction (a mapset has exactly one `owner` at a time). Edge cases: (a) self-demotion (current owner sets their own role to `mapper`/`modder`) returns `409` — they must transfer ownership to another member first; (b) setting a role the user already holds is a `200` no-op; (c) the path-param user not being a member returns `404`; (d) setting another user to `owner` when no `owner` change is needed (i.e., target is already owner) is a `200` no-op. |
| `DELETE` | `/mapsets/{id}/members/{user_id}` | Owner | Remove a member from this mapset. The path param is `User.id` — i.e., the global user identifier the frontend already has, not `MapsetMember.id`. Backend looks up the `MapsetMember` row by `(mapset_id, user_id)` and deletes it. The owner cannot remove themselves (returns `409`); they must transfer ownership via `PUT` first, or delete the entire mapset. |

### `.osu` File Management (`/difficulties/{did}/sections/{sid}/osu`)

> **Architecture change:** All `.osu` parsing, base generation, diffing, merging, and the critical/notice ack flow happen **entirely in the frontend**. The backend is a dumb encrypted blob store. It validates only the outer envelope (file size ≤ 1 MB) and manages version metadata (`is_active` flags). It never inspects `.osu` content.

| Method | Route | Who | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/difficulties/{did}/sections/{sid}/osu` | Owner/Mapper | Upload a `.osu` section version and optionally a new base version. Payload: `{ encrypted_section_content, encrypted_base_content? }`. The frontend has already parsed the file, computed the candidate base, run the critical/notice diff algorithm, and handled any ack modals. The backend inserts the section version first, then the base version, in a single transaction. Both UUIDs are client-generated and sent in the same payload — section-first ordering is a transaction-level FK requirement (the base references the section), not an id-discovery round-trip. |
| `GET` | `/difficulties/{did}/sections/{sid}/osu` | Any member | Download the section's current active `.osu` ciphertext. Returns `404` if none uploaded. The frontend decrypts before presenting to the user. |
| `GET` | `/difficulties/{did}/base.osu` | Any member | Download the active base template ciphertext. Returns `404` until the first section upload. The frontend decrypts before presenting to the user. |
| `GET` | `/difficulties/{did}/merged.osu` | — | **Removed.** Merged difficulty assembly is frontend-only. The frontend fetches the active base + all active section versions, decrypts, merges, and triggers a browser download via `URL.createObjectURL`. |
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

   > **Cross-origin caveat:** `SameSite=Lax` works in local dev because both frontend (`localhost:5173`) and backend (`localhost:8000`) share the same site (`localhost`). It also works in production when both are served from the same domain via the nginx reverse proxy (see Section 14). If you ever split the frontend and backend onto different registrable domains (e.g., `app.example.com` vs `api.other.com`), the cookie must be changed to `SameSite=None; Secure`, and CORS must be configured for credentials.
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

### End-to-End Encryption

All mapset content is **end-to-end encrypted** with AES-256-GCM. The server stores only ciphertext and **cannot decrypt it** — not even the server administrator can read posts, `.osu` files, or mapset metadata.

#### Threat Model
- **Protected against:** Database administrator curiosity, server compromise, backup theft, insider threats.
- **Not protected against:** Compromised client device, XSS on an unlocked session, a malicious group member sharing the passphrase, the passphrase leaking via the out-of-band sharing channel (Discord, email, etc.), browser dev tools, or a compromised server delivering modified frontend JavaScript that exfiltrates the passphrase on entry. The security model assumes the JS bundle the user receives is the audited one; SRI / repository pinning / browser extension audits are out of scope for the MVP.
- **Member removal is not access revocation.** Deleting a `MapsetMember` row revokes API access, but the removed user may still have the passphrase in their `sessionStorage` or memory. They can also decrypt any ciphertext they downloaded before removal. There is no passphrase rotation flow in the MVP; the only recovery from a compromise is to create a new mapset and re-upload everything.
- **Server integrity limitations:** The server is trusted to report the correct "active" version for each section and base (i.e., which `SectionOsuVersion` and `DifficultyBaseOsuVersion` row has `is_active = true`). A malicious server could serve an old version as the active one — the ciphertext is genuine and GCM-valid, so the client would display outdated content without detecting tampering. Version rollback is not mitigated by E2EE; it requires server integrity. This is an accepted trade-off for the MVP. Future mitigation would require chaining version rows (e.g., each row's AAD includes the previous version's ciphertext hash), which is a non-trivial schema change.
  - **Detection:** The version history UI (`OsuVersionHistory`, `BaseVersionHistory`) displays version numbers, so a collaborator who checks the history may notice "we were on v7 yesterday, why is it v5?" However, the main mapset view does not surface version numbers prominently — most users will not notice a silent rollback without explicitly opening the history.

#### Cryptographic Primitives
- **Key derivation:** PBKDF2-SHA256, **600,000 iterations** (OWASP 2023 guidance), 256-bit AES key. Argon2id is the modern recommendation for new systems, but Web Crypto API does not ship it natively. PBKDF2 is the pragmatic choice for a browser-only implementation; the high iteration count and 48-char passphrase provide sufficient defense in depth.
- **Encryption:** AES-256-GCM with a random 96-bit IV per encryption operation.
- **AAD (Additional Authenticated Data):** Every encryption operation binds the ciphertext to its row identity using AAD constructed as the exact UTF-8 string `` `${table}|${id}|${mapset_id}` ``, where `id` is the **row's own primary key** (e.g. `SectionOsuVersion.id`, not `section_id`). This deterministic format (no JSON, no whitespace, fixed key order) prevents ciphertext swapping attacks — a compromised server cannot move a post's encrypted body onto a different post, or swap two versions of the same section, and have it decrypt successfully.
  - **Per-table AAD recipes:**
    - `Mapset`: `Mapset|<mapset_id>|<mapset_id>` (the `id` and `mapset_id` are the same UUID; duplicate is intentional and deterministic).
    - `MapsetMember`: `MapsetMember|<member_id>|<mapset_id>`.
    - `Difficulty`: `Difficulty|<difficulty_id>|<mapset_id>`.
    - `Section`: `Section|<section_id>|<mapset_id>`.
    - `Post`: `Post|<post_id>|<mapset_id>`.
    - `SectionOsuVersion`: `SectionOsuVersion|<version_id>|<mapset_id>`.
    - `DifficultyBaseOsuVersion`: `DifficultyBaseOsuVersion|<version_id>|<mapset_id>`.
    - `DifficultyPin`: `DifficultyPin|<pin_id>|<mapset_id>` (binds both `encrypted_content` — the fully-assembled .osu at pin time — and `encrypted_label` under the pin's own id).
  - **AAD bootstrapping on INSERT:** All primary keys are **UUIDv4 generated by the client** before encryption. The client creates the UUID, includes it in the AAD, encrypts the payload, and sends both the UUID and the ciphertext to the backend. The backend uses the client-provided UUID as the primary key. This avoids the circular dependency of needing the DB-assigned auto-increment ID before encryption.
  - **What AAD does NOT authenticate:** Structural metadata such as foreign keys (`parent_id`, `difficulty_id`, `section_id`) and flags (`is_active`, `version`) are unencrypted and therefore not bound by AAD. A malicious server could, for example, re-parent a reply (`Post.parent_id`) or reorder sections by tampering with `sort_order` ciphertext (which it cannot read) — but it cannot swap ciphertext between rows. This is an accepted limitation: AAD protects ciphertext integrity, not relational semantics.
- **Passphrase:** 48-character alphanumeric string, **auto-generated per mapset on creation**. Shared out-of-band (Discord, etc.).
  - **User-chosen passphrases are forbidden.** Because `encrypted_verification` is a known-plaintext canary, a stolen database enables offline PBKDF2 brute-force. The 48-char auto-generated passphrase (~286 bits of entropy) makes this infeasible; a weak user-chosen passphrase would not. The create-mapset flow must enforce auto-generation with no override.

#### Key Storage
- **Passphrase + salt** are stored in **`sessionStorage`** (survives refresh, dies with tab or browser uninstall). The derived `CryptoKey` itself lives only in **JavaScript memory** and is recreated lazily on demand via PBKDF2. This preserves the Web Crypto API's `extractable: false` property.
- **Wrong-passphrase detection:** The frontend attempts to decrypt `Mapset.encrypted_verification` with the derived key. If the GCM authentication tag fails (AES-GCM throws), the passphrase is wrong. Do not store a hash of the passphrase — that would create a second offline brute-force surface and defeat the canary design.
- The passphrase is **never sent to the server**.
- If a user loses their session (browser uninstalled, cache cleared), they must re-enter the passphrase. If they don't have it, they must obtain it from another group member. **There is no server-side recovery — this is by design.**

#### Encrypted vs. Unencrypted Data

**Unencrypted (structural metadata only):**
- All primary/foreign keys (`id`, `mapset_id`, `user_id`, `parent_id`, etc.)
- `MapsetMember.role`
- `Mapset.passphrase_salt` (public by design)
- `Mapset.encrypted_verification` (ciphertext, harmless without the key)
- Version flags (`is_active`, `version`)
- Audit metadata (`uploaded_by`, `created_at`, `updated_at`)

**Encrypted (server never sees plaintext):**
- `Mapset`: description, song_length_ms
- `Difficulty`: name
- `Section`: name, start_time_ms, end_time_ms, sort_order
- `Post`: content (body)
- `SectionOsuVersion`: content
- `DifficultyBaseOsuVersion`: content

> **Note:** `Mapset.title` is intentionally **not encrypted**. A user may belong to many mapsets (e.g., multiple contest collaborations) and needs to distinguish them on the dashboard before entering a passphrase. The title is visible to anyone who receives an invitation link. A disclaimer is shown during creation and editing.

#### UX Implications
- **Dashboard:** Mapset titles are always visible (plaintext). Other content remains encrypted until the mapset is unlocked with the passphrase.
- **Mapset Page:** If the key is missing, a full-screen passphrase input modal is shown. Nothing else renders until the correct passphrase is entered.
- **Passphrase Sharing:** New members must obtain the passphrase from an existing member out-of-band (Discord, etc.). Any member whose session has the passphrase cached can re-view it in the UI — this is a social convention, not a technical restriction (all unlocked sessions have equal access to the key).
- **Passphrase Rotation:** There is no passphrase rotation or re-encryption flow in the MVP. If a passphrase leaks (e.g., shared in the wrong Discord channel), the only recovery is to create a new mapset and migrate content manually. This is a known limitation.

#### Performance Implications
Because the server cannot read encrypted fields, certain operations that would normally happen server-side must happen client-side:
- **Section ordering:** The backend cannot sort by `sort_order`, `start_time_ms`, or `end_time_ms`. The frontend fetches all sections for a difficulty, decrypts them, and sorts in memory.
- **Post filtering by time range:** The backend cannot index or filter posts by timestamp. The frontend decrypts all posts and derives timestamps client-side.
- **Post count:** Typically <100 per difficulty, so in-memory decryption and sorting is imperceptible. If mapsets grow to thousands of posts, this design will need revisiting (e.g., searchable encrypted indexes or server-side proxy re-encryption).

---

## 6. Frontend Architecture

### Routing (React Router)
- `/login`: Simple page with a "Login with osu!" button. Displays a prominent security notice: *"All mapset data is end-to-end encrypted with AES-256-GCM. The server cannot read your content. Your mapset passphrase is never sent to the server."* Links to the open-source repository for audit (adjust or remove the link if the repository is private).
- `/dashboard`: Grid/list of mapsets the user is a member of. Button to create a new mapset. Mapsets without a cached key show "🔒 Encrypted Mapset".
- `/mapsets/:id`: The main Mapset View page. If the user does not have the decryption key for this mapset, a `PassphraseModal` is shown and no content renders.

### Mapset View Layout
This is the core of the application. It will be a single-page layout inspired by the osu! beatmap discussion page:

1. **Header Bar:**
   - Mapset name (plaintext `title`) and description (decrypted from `encrypted_description` if key is available).
   - Song length displayed as `MM:SS` (decrypted from `encrypted_song_length_ms`).
   - "Manage Members" button (for Owner/Mapper).
   - **"View Passphrase"** button (for Owner, only if key is in memory).
   - **"Download Base Template"** button (fetches encrypted base, decrypts, triggers download).
   - **"Download Full Difficulty (.osu)"** button (fetches all encrypted blobs, decrypts, merges in browser, triggers download via `URL.createObjectURL`).

2. **Difficulty Tabs / Selector (Below Header):**
   - Tabs or a dropdown listing all difficulties in the mapset (e.g., Easy, Normal, Hard).
   - Selecting a difficulty loads its specific sections and posts.
   - "Add Difficulty" button (for Owner/Mapper).

3. **Horizontal Timeline (Top of Main Area):**
   - A full-width horizontal bar representing the decrypted `song_length_ms` of the mapset.
   - The bar is segmented into colored blocks, one per section. Each block's width is proportional to its duration (`end_time_ms − start_time_ms`).
   - Blocks are ordered left-to-right by `start_time_ms`.
   - Each block displays the decrypted section name and duration.
   - Hovering a block highlights it; clicking it selects the section.
   - Visual markers/dots on top of the bar indicate where posts with extracted timestamps exist **for the current difficulty**. The frontend decrypts all posts, extracts timestamps, and computes marker positions.
   - Zooming/panning is **not** required for the MVP; a simple linear scale is sufficient.

4. **Section Detail Panel (Below Timeline, when a section is selected):**
   - Only one section's detail panel is visible at a time, reducing visual clutter.
   - The panel contains:
     - Section name and time range.
     - `.osu` upload/download controls (`OsuUploadButton`, `DownloadOsuButton`).
     - Version history affordance.
     - **Forum posts** that belong to this section (derived client-side from post timestamps).
   - Posts are displayed as a chronological list of `PostCard` components with reply/edit/delete actions.
   - "New Post" input box at the top of the panel.
   - Replies are indented or visually grouped beneath their parent post.
   - **Collapsible posts** and **Replies** behave identically to the old flat forum thread (see `PostCard` below).

5. **Global Posts View (Toggle/Tab):**
   - A "Show All Posts" toggle or separate tab allows viewing the full chronological thread for the difficulty, identical to the old flat forum thread layout. This is useful for sweeping reviews that span multiple sections.
   - When active, the Section Detail Panel is hidden and the full flat thread is shown instead.

> **Note:** The old "Section Sidebar (Left)" from early MVP iterations has been replaced by the timeline + detail-panel layout above. Section names, time ranges, and `.osu` controls now live inside the per-section detail panel.

### Key Components

#### `PostCard`
- **Author Info:** Avatar (small circle), username.
- **Tag Badge:** Color-coded badge (e.g., Blue for Suggestion, Red for Problem, Green for Praise, Grey for General).
- **Primary Timestamp Link:**
  - After decrypting `encrypted_body`, extract the first timestamp. If one exists, display a clickable link.
  - Format: `osu://edit/MM:SS:MMM` or `osu://edit/MM:SS:MMM%20(combos)`.
  - Example: `<a href="osu://edit/00:46:140%20(2,3,4)">00:46:140 (2,3,4)</a>`.
  - Clicking this triggers the browser to open the osu! client.
- **Content:** The decrypted text body. The frontend should scan the text and turn any other valid timestamps into clickable links.
  - **XSS prevention:** Decrypted post content is rendered as plain text via React (which auto-escapes HTML). Only the timestamp linkifier may inject `<a>` elements, and the linkifier must extract regex matches as plain strings — never use `dangerouslySetInnerHTML`. Post bodies are user-controlled and must not be interpreted as HTML under any circumstances.
- **Actions:** "Reply", "Edit", and "Delete" buttons. "Reply" is visible to any member. "Edit" and "Delete" are visible only if the current user is the author (or mapset owner).

#### `CreatePostForm`
- **No separate timestamp input field.** Users simply write their post in a `Textarea`.
- **Tag Selector:** Dropdown for `general`, `suggestion`, `problem`, `praise`.
- **Content:** Textarea. Users paste strings like `00:46:140 (2,3,4) - these are too close` directly.
- **No section selector.** The post's section is derived from its extracted timestamp on the frontend.
- **Reply mode.** When opened as a reply to a specific post, the form displays the parent author and a short excerpt of the parent body. The payload includes `parent_id`.
- **Submit Button:** Frontend extracts the first timestamp from the plaintext body (for `osu://` link generation and timeline placement), then encrypts the body with the mapset key and sends `encrypted_body` (and `parent_id` if replying) via `POST /difficulties/{did}/posts`. The backend stores the ciphertext verbatim.

#### `OsuUploadButton`
- Simple file input wrapper (hidden `<input type="file" accept=".osu">`) triggered by a styled button.
- On file selection, the frontend:
  1. Reads the file as text.
  2. Validates it (contains `[HitObjects]`, ≤ 1 MB).
  3. Parses it and computes the candidate base.
  4. Diffs the candidate base against the active base (fetched and decrypted from the backend).
  5. Handles critical/notice ack modals if needed.
  6. Encrypts the final section content (and new base content if applicable) with the mapset key.
  7. Sends encrypted payload(s) via `POST /difficulties/{did}/sections/{sid}/osu`.
- Shows upload progress and success/error states.

#### `OsuVersionHistory`
- Modal or dropdown listing all versions for a section.
- Displays version number, uploader avatar/username, timestamp, and active status.
- "Activate" button on each non-active version to rollback.

#### `DownloadOsuButton`
- For **section download:** fetches encrypted ciphertext from `GET /difficulties/{did}/sections/{sid}/osu`, decrypts with the mapset key, creates a `Blob`, and triggers download via `URL.createObjectURL`.
- For **base template download:** same pattern using `GET /difficulties/{did}/base.osu`.
- For **merged difficulty download:** fetches active base + all active section ciphertexts, decrypts all, runs the merge algorithm in `osuMerge.ts`, creates a `Blob`, and triggers download. **No backend endpoint for merged download.**

### State Management
- **Global Auth State:** Managed via `useAuth` hook and React Context. Checks `/auth/me` on app load.
- **Encryption State:** Managed via `useEncryption` hook and React Context. Stores a `Map<string, CryptoKey>` (mapset UUID → derived AES key) in **JavaScript memory**, and stores the **passphrase + salt** in **`sessionStorage`** so keys can be re-derived lazily after refresh. Functions: `unlockMapset(mapsetId, passphrase, salt)` derives key via PBKDF2 and verifies against `encrypted_verification` canary. `getKey(mapsetId)` returns the in-memory key or re-derives it from `sessionStorage`. `lockMapset(mapsetId)` clears both memory and `sessionStorage`.
- **Server State:** All mapset, difficulty, section, and post data is managed via TanStack Query (`useQuery`, `useMutation`).
  - Mutations (create/edit/delete post) will invalidate the difficulty query to automatically refresh the forum thread.

---

## 7. osu! Beatmap Discussion Timeline

> **Status:** Implemented in Phase 5. The sidebar list of sections from early MVP iterations has been replaced by the timeline + detail-panel layout described below.

### Motivation
The current MVP renders sections as a vertical sidebar list. A horizontal timeline that visually represents the entire song and segments it by section length is more intuitive for mappers and modders, matching the mental model of osu!'s own discussion interface.

### Layout

1. **Horizontal Timeline (Top of Main Area):**
   - A full-width horizontal bar representing the decrypted `song_length_ms` of the mapset.
   - The bar is segmented ("cut like a cake") into colored blocks, one per section. Each block's width is proportional to its duration (`end_time_ms − start_time_ms`).
   - Blocks are ordered left-to-right by `start_time_ms`.
   - Each block displays the decrypted section name (e.g. "Intro", "Kiai 1") and its duration.
   - Hovering a block highlights it; clicking it selects the section.

2. **Section Detail Panel (Below Timeline):**
   - When a section is selected from the timeline, a detail panel appears directly beneath it.
   - The panel contains:
     - Section name and time range.
     - `.osu` upload/download controls (`OsuUploadButton`, `DownloadOsuButton`).
     - Version history affordance.
     - **Forum posts** that belong to this section (derived client-side from post timestamps, same as §6).
   - Only one section's detail panel is visible at a time, reducing visual clutter.

3. **Global Posts View:**
   - A "Show All Posts" toggle or separate tab allows viewing the full chronological thread for the difficulty, identical to the current §6 forum thread. This is useful for sweeping reviews that span multiple sections.

### Schema Implications

Because sections are strictly sequential and contiguous on the timeline, the `start_time_ms` of every section after the first is **redundant** — it is always the `end_time_ms` of the previous section. This suggests a future schema simplification:

- Drop `encrypted_start_time_ms` from `Section`.
- Keep only `encrypted_end_time_ms` (or rename it to `encrypted_duration_ms`).
- The first section implicitly starts at `0`.
- The frontend derives each section's start time by summing the end times of all preceding sections.

> **Migration note:** This is a breaking schema change and should only be attempted after the MVP is stable. Until then, the frontend can derive the redundant `start_time_ms` from the previous section's `end_time_ms` without touching the DB.

### Interaction Summary

| User Action | Result |
| :--- | :--- |
| Click timeline block | Select section; reveal detail panel with upload/download + posts for that section |
| Hover timeline block | Tooltip with section name, time range, and active `.osu` version number |
| Click post timestamp in detail panel | osu! editor opens at that timestamp |
| Create new post in detail panel | Post is attached to the difficulty (DB unchanged); frontend derives its section from timestamp and shows it in the correct panel |
| Upload `.osu` in detail panel | Same critical/notice ack flow as §9; only the section context is clearer because the user is visually anchored to the correct time range |

---

## 8. Timestamp & osu:// Link Logic

> **Architecture change:** Timestamp extraction happens **entirely in the frontend**. Because post bodies are encrypted (`encrypted_body`), the backend cannot scan them. The frontend extracts timestamps from plaintext before encryption, and re-extracts them from decrypted plaintext for display.

### Input Format
Users will copy strings from the osu! editor status bar or type them manually. These appear inline in their post body:
- `00:46:140`
- `00:46:140 (2,3,4)`
- `01:47:766`
- `01:47:766 (5)`

A single post may contain multiple timestamps:
> "00:46:140 (2,3,4) - these circles are too close. Also 01:47:766 feels a bit empty."

### Frontend Extraction Logic
Before encrypting a post body for upload, the frontend scans the plaintext for the **first** valid timestamp and extracts it into `{ ms, combos }` for use in `osu://` link generation and timeline placement. The encrypted payload sent to the backend contains only the ciphertext; the extracted timestamp lives only in frontend memory.

```typescript
function extractFirstTimestamp(content: string): { ms: number; combos?: string } | null {
  const pattern = /(\d{2}):(\d{2}):(\d{3})(?:\s+(\([^)]+\)))?/;
  const match = content.match(pattern);
  if (!match) return null;

  const [, minutes, seconds, milliseconds, combos] = match;
  const totalMs = parseInt(minutes, 10) * 60000 + parseInt(seconds, 10) * 1000 + parseInt(milliseconds, 10);
  return { ms: totalMs, combos };
}
```

> **Type safety note:** `combos` may be `undefined`. Downstream code that constructs `osu://` links must guard against this (e.g., `combos ? \`osu://edit/${timeStr}%20${combos}\` : \`osu://edit/${timeStr}\``) rather than using a non-null assertion (`combos!`).

### URL Generation (Frontend)
When rendering the primary timestamp link after decrypting the post body:
```typescript
function generateOsuLink(ms: number, combos?: string): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = ms % 1000;
  
  const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(milliseconds).padStart(3, '0')}`;
  
  if (combos) {
    return `osu://edit/${timeStr}%20${encodeURIComponent(combos)}`;
  }
  return `osu://edit/${timeStr}`;
}
```
**Critical:** Do not strip or modify the `(2,3,4)` part. It must be URL-encoded (space becomes `%20`) and appended to the link so that opening osu! selects those specific hit objects.

---

## 9. `.osu` File Management & Merging

> **Architecture change:** All `.osu` parsing, base generation, diffing, merging, and the critical/notice ack flow happen **entirely in the frontend** (TypeScript / Web Crypto API). The backend is a dumb encrypted blob store — it stores and serves ciphertext only. The rules below describe the **client-side** algorithm.

This is a core feature that transforms the forum into a collaborative beatmap manager. Each `Section` can have its own `.osu` file, and the full difficulty can be downloaded as a merged, valid `.osu` file assembled in the browser.

### Storage
Since `.osu` files are small (a few KB), they are stored as encrypted `TEXT` columns directly in PostgreSQL. This ensures portability, simple backups, and easy version control. Uploaded files are capped at **1 MB** — generous for a text format, and any larger file is almost certainly malformed or malicious. The backend validates only the size; all parsing and validation happen client-side.

### What we store, what we don't
A `.osu` file is **just a text file** describing a beatmap: headers, timing points, hit objects, and references (by filename) to external assets. We store and serve only the encrypted `.osu` text. We do **not** store, upload, or merge:
- **Audio** (`AudioFilename` references the mapper's local `.mp3`/`.ogg`)
- **Background images / video** (referenced from `[Events]`)
- **Custom hitsounds** (the `.wav` files referenced from `[Events]` or hit object samples)
- **Skin elements** (any image/sound override)

The merged difficulty download is a single text file assembled in the browser. To actually play the merged map, the user must have the same audio (and any referenced custom hitsounds/storyboard assets) locally in the matching beatmap folder. This is by design: this is a modding/collaboration tool, not a beatmap distribution platform, and `AudioFilename` is treated as a Critical setting precisely so all collaborators agree on which local file the `.osu` references.

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
| **Critical** | All key/value lines in `[Difficulty]`; `AudioFilename` in `[General]`; positive `[TimingPoints]` (uninherited / BPM) | **Reject the upload** with a frontend modal. Nothing is written. The uploader either cancels or confirms — see "Acknowledged critical mismatch" below. **Only the mapset `owner` can permanently change critical settings.** |
| **Notice** | All other lines in `[General]`, `[Events]`, `[Metadata]` — **except `Version` in `[Metadata]`**, which mappers customize per-collaborator | Role-dependent: see "Acknowledged notice mismatch" below. |
| **Ignored** | `[Metadata] Version` (collab convention); inherited (negative) `[TimingPoints]` (per-section slider velocity, merged at download time); `[Colours]` (cosmetic, last-write-wins on the base); `[Editor]` (per-mapper editor state — bookmarks, distance spacing, beat divisor — never authoritative across the collab) | No effect on the base unless the line falls into a bucket above. |

Positive `[TimingPoints]` (BPM) are critical: a section that disagrees with the base on BPM cannot be merged sensibly, so it gets the same modal treatment as a `[Difficulty]` change. Inherited (negative) `[TimingPoints]` remain per-section and are excluded from this comparison (they live inside the section, not the base).

When the frontend surfaces a diff in the modal, **per-key fields** (everything in `[Difficulty]`, `General:AudioFilename`, the rest of `[General]`, `[Metadata]` except `Version`) are shown as a "base → yours" pair so the uploader can see exactly what's about to change or be normalized away. Line-list fields (`[Events]`, `[TimingPoints]`) are shown by name only — their content is too large for an inline comparison.

#### Acknowledged critical mismatch

When the frontend detects a critical mismatch, it shows a role-aware modal. On confirm, it re-submits the upload with the user's choice encoded into the payload:

- **Owner:** sees `owner-critical` modal listing changed fields as base-vs-yours, and chooses between **Promote** (treat the new file as authoritative — sends section + new base) and **Discard my changes** (rewrites the section against the active base on both critical AND notice scopes, sends section only, no new base). Promote gets a destructive framing: *"CRITICAL: are you sure? You're about to change `OverallDifficulty`, `AudioFilename`, … on the base. Every collaborator's section will use these settings going forward."* Discard shows a warning banner naming every dropped field across both scopes.
- **Mapper:** the base wins. The frontend rewrites the section against the active base on both critical AND notice scopes **before encrypting** (including replacing the section's positive timing points with the base's, while keeping the section's inherited / negative TPs), then sends the rewritten section version to the backend. The base is **not** changed.
- **Modder:** can't reach this code path; modders cannot upload `.osu` at all. The frontend gate hard-errors before any server work; the backend route also rejects with `403`.

When a critical and a notice diff exist simultaneously, the critical modal lists the critical fields as the primary list and surfaces the notice fields in a secondary "Also Changed" panel. Both Discard and Promote act on the union — never leaving notice changes silently in the section content after a Discard.

This split is deliberate. Owners are the only role with authority over critical mapset properties (difficulty, audio, BPM); mappers can iterate on their section's hit objects and SV details but not silently change the difficulty's identity.

#### Acknowledged notice mismatch

A notice diff (background image, metadata edit, break placement, etc.) is also role-gated. Mappers cannot create new base versions silently from notice changes — that was the original "anyone can create a new base version" footgun.

- **Owner:** sees an `owner-notice` modal listing the changed fields with base-vs-yours values, and chooses between **Promote** (treat the new file as the authoritative base — sends section + new base) and **Discard my changes** (rewrites the section's notice fields to match the active base, sends section only, no new base).
- **Mapper:** no modal. The frontend silently rewrites the section's notice fields to match the active base (positive TPs are unaffected — they're already in critical) and uploads the rewritten section with no new base version. A non-blocking warning banner lists which fields were overwritten so the mapper notices that, e.g., their break edits or background change were dropped.

Notice normalization rewrites: non-`AudioFilename` keys in `[General]` to the base's values, non-`Version` keys in `[Metadata]` to the base's values, and replaces the section's `[Events]` data lines wholesale with the base's. Keys missing from one side or the other are left as-is — the normalizer is idempotent and never invents lines.

#### Algorithm — on every section upload (frontend)

1. Validate the file is well-formed (contains `[HitObjects]`) and ≤ 1 MB.
2. Reject if `role` is not `owner` or `mapper` (modders are review-only; `null` means we couldn't determine membership). The backend also `403`s, but the frontend hard-errors before sending so the user gets a clear message instead of a generic server error.
3. Parse and compute the candidate base.
4. **No active base for this difficulty (first upload):** **owner only**. Encrypt the section content and the candidate base, then send both to the backend. The backend inserts the section version first, then the candidate base as version 1 with `source_section_version_id` pointing at it. Non-owners get a hard error asking them to wait for the owner to seed the base.
5. **Active base exists** — diff candidate against active base:
   - **Critical mismatch:** show role-specific modal (with notice fields shown under "Also Changed" if both buckets diff), abort the implicit upload.
     - *Owner Promote:* encrypt section as-is, encrypt new base, send both. Backend inserts section first, then base, in one transaction.
     - *Owner Discard my changes:* rewrite section against active base on critical + notice, encrypt, send section only. Base untouched. Warning banner names the discarded fields from both buckets.
     - *Mapper "I'm aware":* rewrite section against active base on critical + notice, encrypt, send section only. Base untouched.
   - **Notice-only mismatch:** role-dependent.
     - *Owner:* show `owner-notice` modal. **Promote** sends section + new base; **Discard my changes** rewrites notice fields to match base and sends section only.
     - *Mapper:* rewrite notice fields to match base silently, upload section with no new base, show a warning banner listing the overwritten fields.
   - **No diff:** encrypt section, send to backend. Backend inserts section version only in one transaction. Base untouched.

The backend enforces the owner-only base-write policy independently: any `POST /difficulties/{did}/sections/{sid}/osu` with a non-null `base_version` field by a non-owner role returns `403`. This is the source of truth — a crafted request cannot bypass the frontend gates.

> **Insert order matters.** Whenever a base version is created, its `source_section_version_id` references the section version produced by the same upload. The backend must insert the section version first, then the base — otherwise the FK fails at INSERT time (the constraint is not deferred). Both IDs are client-generated UUIDs sent in the same payload; the ordering is a transaction-level FK requirement, not an id-discovery round-trip.
>
> The "single transaction" requirement is what keeps the partial-unique-index DB constraints (Section 3) safe. Without it the index would fire mid-flight and abort the whole operation. With it, deactivate-then-activate is atomic.

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

### Merged Difficulty Download (Frontend-only)
The frontend assembles a complete, valid `.osu` file from the active base + every section's active version:

1. **Fetch & decrypt:** download the active base ciphertext and all active section ciphertexts, then decrypt them using the mapset key.
2. **Headers:** start with the active base content (everything before `[HitObjects]`). This is the authoritative source of `[General]`, `[Metadata]`, `[Events]`, `[Difficulty]`, `[Colours]`.
3. **Timing points:** collect lines from:
   - The active base (positive BPM points only).
   - Every section's active `.osu` file (all timing points — positive and negative).
4. **Sort & deduplicate:**
   - Sort by `time` (first column) ascending.
   - Deduplicate by (timestamp, type) where type is "positive" (`beatLength > 0`) or "negative" (`beatLength < 0`):
     - At most one positive line per timestamp.
     - At most one negative line per timestamp.
     - One positive + one negative at the same timestamp is allowed and preserved (this is how osu! encodes a BPM change with a custom SV at the same instant).
   - **Tiebreaker when two lines of the same type collide on the same timestamp:** section content overrides the base; among sections, the lower `Section.sort_order` wins (with `Section.id` as a stable secondary tiebreaker). This makes the merge deterministic and gives the earliest section authority over its own boundary.
5. **Hit objects:** collect `[HitObjects]` lines from every section's active version, sort ascending by `time` (third column).
6. **Assemble:** write headers → `[TimingPoints]` → `[HitObjects]`.
7. **Trigger download:** create a `Blob` from the assembled string, generate `URL.createObjectURL`, and programmatically click an `<a download="...">` element.

### Section Download (`GET /difficulties/{did}/sections/{sid}/osu`)
Returns the encrypted `.osu` ciphertext of the currently active version for that section. The frontend decrypts it before presenting it to the user for editing. The decrypted content is byte-for-byte identical to what was originally uploaded.

### Bookmark Import (Optional Stretch)
As a convenience feature, users can optionally upload a `.osu` file to auto-generate `Section` records from `[Editor] Bookmarks:`. This is unchanged from the original spec but is now considered a Phase 7 stretch feature rather than part of core `.osu` management.

---

## 10. Docker & Local Development

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

## 11. Implementation Order (MVP)

A phased approach to keep the project testable and avoid large merge conflicts. Each task below is designed to be small (typically 50–300 lines of code), self-contained, and reviewable. **A sub-agent should receive one task at a time.** After each task, run `docker-compose up --build` to verify nothing is broken.

> **Testing Rule:** Every phase must include tests. Backend changes require passing unit/integration tests. Frontend changes require passing component tests. See Section 14 for test setup requirements.

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

### Phase 2: Mapset Management & Encryption Foundation

| # | Task | What It Produces | Verification |
|---|------|------------------|------------|
| 2.1 | Create `Mapset` and `MapsetMember` models + migration | Update `models.py` with encrypted fields, `passphrase_salt`, `encrypted_verification`. **Migration strategy:** Since Phase 1 created plaintext `User` only, this is a clean additive migration. If any plaintext content tables exist from prior work, drop and recreate them **only if** (a) explicitly authorized by the project owner and (b) the table contains no rows — otherwise stop and ask. | DB schema matches spec; write model unit tests |
| 2.2 | Implement frontend crypto layer | `src/utils/crypto.ts` with PBKDF2 + AES-GCM encrypt/decrypt | Round-trip tests in `crypto.test.ts`; wrong passphrase fails; tampered ciphertext fails |
| 2.3 | Implement `EncryptionContext` | `src/contexts/EncryptionContext.tsx` with `sessionStorage` persistence | Key survives refresh, dies with tab; can unlock/lock mapsets |
| 2.4 | Implement `POST /mapsets` | Create mapset + auto-add owner as `MapsetMember`. Payload uses encrypted fields + salt + verification | Can create mapset via API; write integration test |
| 2.5 | Implement `GET /mapsets` | List mapsets for current user | Returns only user's mapsets; write test |
| 2.6 | Implement `GET /mapsets/{id}` | Full mapset details | Returns 403 for non-members; write test |
| 2.7 | Implement `PUT /mapsets/{id}` + `DELETE /mapsets/{id}` | Update/delete with role checks | Only owner/mapper can update; only owner can delete; write tests |
| 2.8 | Build Dashboard page | `src/pages/DashboardPage.tsx` + `src/components/MapsetCard.tsx` | Lists user's mapsets; encrypted titles decrypt if key is cached; write component test |
| 2.9 | Build "Create Mapset" form | Modal/form. Auto-generates 48-char passphrase, shows it with **"Copy to clipboard"** and a mandatory **"I have saved this passphrase"** checkbox. The checkbox must be checked before the form can be submitted. Include a warning: *"If you lose this passphrase and no other member has it, all mapset data is permanently unrecoverable. There is no server-side recovery."* | Creates mapset with encrypted fields; appears on dashboard; write component test |
| 2.10 | Build `PassphraseModal` | `src/components/PassphraseModal.tsx` | Prompts for passphrase on locked mapset; unlocks and decrypts on correct entry; write component test |
| 2.11 | Update Login page with security banner | `src/pages/LoginPage.tsx` | Displays E2EE notice and links to source code; write component test |

**Deliverable:** A user can create an encrypted mapset, see it on their dashboard, and unlock it with the passphrase. All tests pass.

---

### Phase 3: Difficulties, Sections, & Frontend `.osu` Engine

| # | Task | What It Produces | Verification |
|---|------|------------------|------------|
| 3.1 | Create `Difficulty`, `Section`, `SectionOsuVersion`, `DifficultyBaseOsuVersion` models + migration (incl. partial unique indexes on `is_active`) | Update `models.py` with encrypted fields | DB schema matches spec; partial unique indexes prevent two `is_active = true` rows per section/difficulty; write model tests |
| 3.2 | Implement Difficulty CRUD routes | `POST/GET/PUT/DELETE` for difficulties (encrypted payloads) | Full CRUD works via API; write integration tests |
| 3.3 | Implement Section CRUD routes | `POST/PUT/DELETE` for sections (encrypted payloads) | Sections scoped to difficulty; write tests |
| 3.4 | Build Difficulty Tabs UI | `src/components/DifficultyTabs.tsx` | Switching difficulties updates view; decrypts names if key available; write component test |
| 3.5 | Build Section Sidebar UI | `src/components/SectionList.tsx` | Sections display per difficulty; decrypts names/boundaries if key available; write component test |
| 3.6 | Build frontend `.osu` parser | `src/utils/osuParser.ts` | Parse `.osu` text into sections; extract timing points and hit objects; validate `[HitObjects]` presence and ≤ 1 MB; write unit tests with sample `.osu` fixtures |
| 3.7 | Build frontend base generator & diff engine | `src/utils/osuBase.ts` | Compute candidate base; classify into Critical/Notice/Ignored buckets; diff candidate vs active base; return mismatch report | Unit test parser, base generator, bucket classification, and diff algorithm |
| 3.8 | Build frontend merge engine | `src/utils/osuMerge.ts` | Collect timing points from base + sections, sort, deduplicate by (timestamp, type), collect hit objects, assemble final `.osu` string | Unit test merge with sample files; verify deterministic output |
| 3.9 | Implement `.osu` upload endpoint (backend blob store) | `POST /difficulties/{did}/sections/{sid}/osu` accepts encrypted section + optional encrypted base | Backend stores ciphertext verbatim, manages `is_active` flags in single transaction; write integration test |
| 3.10 | Implement section `.osu` download | `GET /difficulties/{did}/sections/{sid}/osu` returns encrypted ciphertext | Frontend decrypts before presenting; write test |
| 3.11 | Add `.osu` upload/download UI | `OsuUploadButton`, download button in Section Sidebar | File picker → frontend parses → handles ack modals → encrypts → uploads; download fetches ciphertext → decrypts → triggers `URL.createObjectURL`; write component tests |
| 3.12 | Implement section version history endpoints | `GET /difficulties/{did}/sections/{sid}/osu/versions`, `POST .../activate` | Can list section versions and roll back atomically; write tests for the active-version invariant |
| 3.13 | Implement base version history endpoints | `GET /difficulties/{did}/base/versions`, `POST /difficulties/{did}/base/versions/{vid}/activate` | Can list base versions and roll back atomically; write tests for the active-version invariant |
| 3.14 | Add section version history UI | `OsuVersionHistory` modal | Can view section history and switch versions; write component test |
| 3.15 | Add base version history UI | `BaseVersionHistory` modal in the difficulty header | Lists base versions with their `source_section_version_id`; activate any prior version; write component test |
| 3.16 | Add critical-ack upload flow UI | Frontend handler for upload that branches on role: owner sees destructive "CRITICAL: Are you sure?" modal; mapper sees "your diff differs from the base, (Cancel) (I'm aware)" modal; both proceed with appropriate encrypted payload on confirm | Both modals render correctly; "I'm aware" path produces an upload whose stored content has critical lines normalized to base values; write component tests for both branches |
| 3.17 | Verify backend has no `.osu` parsing logic | Confirm `backend/app/services/osu_parser.py` does not exist; if it does, delete it and update imports. Add a CI check: `! grep -rn --include='*.py' -P '(import\s+osu_parser|from\s+.*osu_parser|services\.osu_parser)' backend/app/` so regressions fail the build. This catches imports and service references but ignores comments and test fixtures. | Backend is a pure blob store with no parsing logic; verify `pytest` still passes |

**Deliverable:** Users can create difficulties and sections, upload `.osu` files (with client-side parsing, base diffing, and ack flow), download decrypted sections, and manage versions. All tests pass.

---

### Phase 4: Forum Posts (Client-Side Encrypted)

| # | Task | What It Produces | Verification |
|---|------|------------------|------------|
| 4.1 | Create `Post` model + migration | Update `models.py` with `encrypted_body`, remove `timestamp_ms`/`hit_object_combos` | DB schema matches spec; write model test |
| 4.2 | Implement Post CRUD routes | `POST/PUT/DELETE` for posts (encrypted payloads) | Author-only edit, author/owner delete; backend stores ciphertext verbatim; write tests |
| 4.3 | Implement post listing | Posts returned with difficulty details | Chronological by `created_at`; write test |
| 4.4 | Build `PostCard` component | Avatar, tag badge, decrypted content display | Decrypts `encrypted_body` via `EncryptionContext`; extracts and linkifies timestamps; write component test |
| 4.5 | Build `CreatePostForm` component | Textarea, tag selector | Frontend extracts first timestamp from plaintext before encrypting body; creates post via API; write component test |
| 4.6 | Render forum thread | Posts list in Mapset View | Posts display per difficulty; frontend sorts by extracted timestamp after decryption; write integration test |

**Deliverable:** Users can create encrypted modding posts, view decrypted posts with clickable timestamps, and edit/delete their own posts. All tests pass.

---

### Phase 5: osu! Beatmap Discussion Timeline & Merged Download (Frontend-Only)

> **Scope change:** This phase now implements the full timeline UI described in §7 (previously "Post-MVP"). The sidebar list of sections is replaced by a horizontal osu!-style timeline with segmented section blocks and a detail-panel layout.

| # | Task | What It Produces | Verification |
|---|------|------------------|------------|
| 5.1 | Implement client-side timestamp extraction | `src/utils/extractTimestamp.ts` | Regex extracts first timestamp + combos from plaintext; write unit test |
| 5.2 | Integrate extraction into `CreatePostForm` | Frontend extracts timestamp before encrypting body | Timestamp available in memory for `osu://` link generation; write component test |
| 5.3 | Update `PostCard` with `osu://` links | `generateOsuLink` function, clickable primary timestamp + linkify body | Link opens osu! client; write component test |
| 5.4 | Linkify all timestamps in post content | Frontend regex to find additional timestamps in decrypted body | All timestamps in body are clickable; write component test |
| 5.5 | Build segmented Timeline component | `Timeline.tsx`: full-width horizontal bar representing `song_length_ms`, segmented into colored blocks per section (width ∝ duration), ordered by `start_time_ms`; hover tooltips; click selects section | Write component test |
| 5.6 | Add post markers to Timeline | Dots on timeline for posts with extracted timestamps, positioned by `ms / song_length_ms`; click scrolls to post | Write component test |
| 5.7 | Build SectionDetailPanel | `SectionDetailPanel.tsx`: section name + time range, `.osu` upload/download controls (`OsuUploadButton`, `DownloadOsuButton`), version history affordance, forum posts belonging to this section (derived from timestamps), reply/edit/delete inline | Write component test |
| 5.8 | Add Global Posts view | "Show All Posts" toggle/tab; when active, renders full chronological forum thread (replies indented) identical to old §6 layout | Write component test |
| 5.9 | Refactor MapsetPage layout | Replace Section Sidebar with Timeline + SectionDetailPanel; integrate Global Posts toggle; header bar retains merged-download button | Write integration test |
| 5.10 | Implement merged `.osu` download (frontend) | `DownloadOsuButton.tsx` or inline handler: fetches active base + all active section ciphertexts, decrypts, merges via `osuMerge.ts`, creates Blob, triggers download | Write integration test with sample .osu files |
| 5.11 | Add merged download UI | "Download Full Difficulty (.osu)" button in mapset/difficulty header | Write component test |

**Deliverable:** osu!-style beatmap discussion timeline. Sections as colored blocks, posts as dots. Click section → see detail panel with uploads and posts. Toggle to see all posts. Merged `.osu` download works. All tests pass.

---

### Phase 6: Editing & Members

| # | Task | What It Produces | Verification |
|---|------|------------------|------------|
| 6.1 | Implement post editing (`PUT`) | `PUT /difficulties/{did}/posts/{pid}` | Author can edit; frontend re-encrypts new body; write test |
| 6.2 | Add "Edit" button to `PostCard` | Conditional rendering | Only author sees edit button; write component test |
| 6.3 | Implement member invitation | `POST /mapsets/{id}/members` | Resolve username to user_id; write integration test |
| 6.4 | Implement member removal + role change | `DELETE /mapsets/{id}/members/{user_id}` and `PUT /mapsets/{id}/members/{user_id}` | Owner-only; ownership-transfer atomicity; self-demotion is rejected; write tests for all edge cases (Section 4) |
| 6.5 | Add "Manage Members" UI | Invite/remove members modal | Functional member management; owner can re-view passphrase if key is in memory; write component test |
| 6.6 | Handle new member passphrase flow | When an invited user first opens a mapset, show `PassphraseModal` | User must enter correct passphrase to unlock and see content; write component test |

**Deliverable:** Users can edit posts, invite collaborators, and new members can unlock mapsets with the shared passphrase. All tests pass.

---

### Phase 7: Polish, Bookmark Import, & Final Testing

| # | Task | What It Produces | Verification |
|---|------|------------------|------------|
| 7.1 | Implement bookmark import (stretch) | Parse `[Editor] Bookmarks:` from decrypted `.osu` upload to auto-create sections | Creates sections correctly; write parser unit test |
| 7.2 | Add loading states & error handling | Spinners, toast notifications | UX feels responsive; write component tests |
| 7.3 | Run full test suite | All backend and frontend tests | `pytest` and `npm test` pass; coverage reflects "everything that matters" per Section 12, not a numeric threshold |
| 7.4 | Final Docker Compose testing | All services start cleanly | `docker-compose up --build` works end-to-end |
| 7.5 | Update deployment docs | Reflect any final env vars or config changes | Docs are accurate |
| 7.6 | Verify E2EE claim | Automated integration test: intercept all API requests/responses and assert that (a) no plaintext content field name appears in JSON payloads (fields that must never be plaintext on the wire: `title`, `description`, `song_length_ms`, `name`, `content`, `body`, `start_time_ms`, `end_time_ms`, `sort_order`); and (b) every `encrypted_*` value is base64-decodable and at least 28 bytes (12-byte IV + 16-byte GCM tag), catching the bug where a developer sent plaintext inside an `encrypted_*` wrapper. Confirm every content field uses the `encrypted_*` prefix. Manual audit: inspect DB directly with `psql` and confirm all `encrypted_*` columns contain base64 ciphertext strings, never human-readable text. | Both automated test and manual audit pass; no plaintext leaks detected |

**Deliverable:** A fully functional MVP with end-to-end encryption, containerized, tested, and ready for deployment.

---

## 12. Testing Strategy

Testing is not optional. Every task in Section 11 must include tests. This ensures that sub-agents produce verifiable, correct code and prevents regressions as the codebase grows.

### Backend Tests (pytest)

**Frameworks:** `pytest`, `pytest-asyncio`, `httpx` (for async FastAPI testing).

**Test Structure:**
```
backend/tests/
├── conftest.py          # Shared fixtures: async DB engine, test client, mock user
├── test_auth.py         # OAuth flow, JWT cookies, /auth/me
├── test_mapsets.py      # Mapset CRUD, permissions
├── test_difficulties.py # Difficulty CRUD
├── test_sections.py     # Section CRUD
├── test_posts.py        # Post CRUD
└── test_members.py      # Member invitation, permissions
```

> **Note:** `services/test_osu_parser.py` is removed — all `.osu` parsing, base generation, diffing, and merging are tested in the frontend test suite (`frontend/src/utils/osuParser.test.ts`, `osuBase.test.ts`, `osuMerge.test.ts`).

**Key Fixtures (conftest.py):**
- `db_session`: Async SQLModel session connected to a **dedicated PostgreSQL test container** (separate from the dev `db` service, with its own volume). We do not test against SQLite — the production driver (`asyncpg`) and Postgres-specific behavior (`selectinload`, partial unique indexes, `ENUM` types, JSON columns, deferrable constraints, dialect quirks) must be exercised in tests, not papered over.
- `client`: `httpx.AsyncClient` mounted to the FastAPI app.
- `mock_user`: A pre-authenticated `User` object injected into `get_current_user` dependency for tests.

**Testing Rules:**
- Every API endpoint must have at least one integration test.
- Permission checks must be tested explicitly (e.g., a `modder` cannot upload `.osu`).
- The backend does not parse `.osu` content — use fake ciphertext strings (e.g., `"encrypted:test"`) in backend tests where encrypted payloads are required.

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
│   ├── useAuth.test.ts    # Auth state logic
│   └── useEncryption.test.ts  # Encryption key management
├── utils/
│   ├── crypto.test.ts     # PBKDF2 + AES-GCM round-trip
│   ├── osuParser.test.ts  # .osu parsing, base generation, diff algorithm
│   └── osuMerge.test.ts   # Timing point deduplication, hit object merge
├── components/
│   ├── MapsetCard.test.tsx
│   ├── PostCard.test.tsx
│   ├── CreatePostForm.test.tsx
│   ├── OsuUploadButton.test.tsx
│   ├── OsuVersionHistory.test.tsx
│   └── PassphraseModal.test.tsx
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

## 13. Deployment Strategy

The architecture is designed for maximum flexibility:

- **Local Development:** `docker-compose up`.
- **Cheap VPS (e.g., Hetzner, DigitalOcean):**
  - Clone the repo (or just write `docker-compose.prod.yml`) on the server.
  - Create a `.env` file with production secrets.
  - Run `docker-compose -f docker-compose.prod.yml up -d`.
  - SSL termination is handled by the frontend image's own nginx (see Section 14.5). There is no extra reverse-proxy layer in front of it; certificates are bind-mounted from the host.
- **Split Services:**
  - **Frontend:** Easily deployed to Vercel or Netlify (it's a static SPA).
  - **Backend + DB:** Deployed to Railway, Render, or Fly.io.
  - **Database:** Use the free tier of Supabase PostgreSQL if preferred, simply by changing the `DATABASE_URL`.

Because everything is in Docker, moving from local to any host is trivial.

---

## 14. Deployment Guide

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
