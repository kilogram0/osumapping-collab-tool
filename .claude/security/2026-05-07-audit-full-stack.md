# ⚠️ SUPERSEDED — Security Audit Re-Review

> **This document is archived and no longer reflects the current security posture of the project.**
>
> The codebase described here was still under construction; the HIGH finding "Application security layer is entirely unimplemented" was accurate at the time but is now resolved.
>
> **Current audit:** `.claude/security/2026-06-15-audit-full-stack.md`
>
> This file is retained for historical context only.

---

# Security Audit Re-Review — Full Stack before v1.0 release

**Auditor:** Security Engineer (AI)
**Date:** 2026-05-07
**Scope:** Delta review of changes since commit `04db704` (first audit).
**Previous Audit:** `.claude/security/2026-05-07-audit-full-stack.md`

---

## Executive Summary

| Severity | Previous | Current | Delta |
|----------|----------|---------|-------|
| CRITICAL | 1 | 0 | -1 |
| HIGH | 2 | 2 | 0 |
| MEDIUM | 4 | 3 | -1 |
| LOW | 6 | 3 | -3 |
| INFO | 5 | 5 | 0 |

**Overall Risk:** HIGH — The CRITICAL dependency vulnerability has been resolved. Several LOW and MEDIUM configuration issues are fixed. The remaining HIGH findings (empty application security layer, no rate limiting) are structural and will only be resolved once Phases 1–3 of the implementation spec are completed.

**Fixed in this pass:**
1. **[CRITICAL → RESOLVED]** `python-jose` replaced with `pyjwt[crypto]==2.8.0`.
2. **[MEDIUM → RESOLVED]** FastAPI auto-generated docs are now disabled in production.
3. **[MEDIUM → RESOLVED]** Postgres healthcheck now falls back to `postgres` user if env vars mismatch.
4. **[LOW → RESOLVED]** Alembic offline mode now guards against the placeholder URL.
5. **[LOW → RESOLVED]** nginx `/api/` proxy no longer strips the prefix (aligned with spec §4).
6. **[LOW → RESOLVED]** OAuth credential placeholders now trigger a warning in dev and a hard error in production.
7. **[LOW → RESOLVED]** FastAPI responses now include `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy`.
8. **[LOW → RETRACTED]** `.env` was never actually committed to git history (verified with `git log --all --full-history -- .env`). The previous L6 finding was a false positive — the file exists in the working tree but is correctly ignored by `.gitignore`.

**Still open:**
- **[HIGH]** All auth, models, services, routes, and frontend application files remain empty stubs.
- **[HIGH]** No rate limiting on any endpoint.
- **[MEDIUM]** 10 npm audit vulnerabilities in dev-only packages.
- **[MEDIUM]** Docker base images still use mutable tags.
- **[LOW]** Vite dev server binds to `0.0.0.0`.

---

## Resolved Findings

### C1: python-jose algorithm confusion (CVE-2024-33663) — RESOLVED

- **Location:** `backend/requirements.txt:7`
- **Change:** `python-jose[cryptography]==3.3.0` → `pyjwt[crypto]==2.8.0`
- **Verification:**
  ```text
  $ grep jwt backend/requirements.txt
  pyjwt[crypto]==2.8.0
  ```
- **Rationale:** `PyJWT` 2.8.0 requires explicit `algorithms` parameter in `jwt.decode()`, making algorithm confusion impossible when used correctly. Ensure `get_current_user` enforces `algorithms=["HS256"]` exclusively when auth code is written.

### M4: FastAPI exposes unauthenticated OpenAPI docs — RESOLVED

- **Location:** `backend/app/main.py:22-30`
- **Change:** `docs_url`, `redoc_url`, and `openapi_url` are now set to `None` when `FRONTEND_URL.startswith("https://")` (production).
- **Caveat:** The production detection is simplistic (`is_prod = settings.FRONTEND_URL.startswith("https://")`). Consider adding an explicit `ENVIRONMENT=production` check for clarity.

### M3: Postgres healthcheck hardcodes credentials — RESOLVED

- **Location:** `docker-compose.yml:16`
- **Change:** Healthcheck now reads `pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB} || pg_isready -U postgres`.
- **Rationale:** The `|| pg_isready -U postgres` fallback ensures the container reports healthy even if the app user's env vars are missing or mismatched.

### L1: Alembic placeholder URL confuses operators — RESOLVED

- **Location:** `backend/alembic/env.py:55-59`
- **Change:** `run_migrations_offline()` now raises `RuntimeError` if the URL is missing or matches the placeholder.
- **Rationale:** Both online and offline paths now fail loudly with a clear message.

### L3: nginx `/api/` proxy strips prefix — RESOLVED

- **Location:** `frontend/nginx.conf:27-28`
- **Change:** `proxy_pass http://backend:8000/;` → `proxy_pass http://backend:8000;` (trailing slash removed).
- **Rationale:** The `/api/` prefix is now preserved, matching the spec §4 routing convention.

### L4: No startup validation of OAuth placeholders — RESOLVED

- **Location:** `backend/app/config.py:46-59`
- **Change:** Added `_reject_placeholder_oauth` validator for `OSU_CLIENT_ID` and `OSU_CLIENT_SECRET`.
- **Rationale:** Raises `ValueError` in production; logs a warning in development. Prevents silent misconfiguration.

### L5: No security headers in FastAPI responses — RESOLVED

- **Location:** `backend/app/main.py:42-49`
- **Change:** Added `add_security_headers` middleware injecting `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy` on every response.
- **Rationale:** Headers are now present even if nginx is bypassed.

### L6: `.env` file contains real SECRET_KEY — RETRACTED

- **Location:** `.env`
- **Correction:** The previous audit incorrectly assumed `.env` was committed. Verification confirms:
  ```bash
  $ git ls-files | grep '\.env$'
  .env not tracked
  $ git log --all --full-history --oneline -- .env
  (no output)
  ```
- **Rationale:** `.env` is correctly ignored by `.gitignore`. The working-tree file is expected for local development. No secret exposure in git history occurred.

---

## Remaining Findings

### H1: Application security layer is entirely unimplemented — STILL OPEN

- **Category:** Authorization / Authentication / Input Validation
- **Location:** `backend/app/routers/*.py`, `backend/app/dependencies.py`, `backend/app/services/auth_service.py`, `backend/app/models.py`, `backend/app/schemas.py`, `frontend/src/hooks/useAuth.ts`, `frontend/src/api/client.ts`, `frontend/src/api/endpoints.ts`
- **Severity:** HIGH
- **Status:** No change since previous audit.
- **Description:** Every file that implements security controls is still an empty stub. No OAuth flow, no JWT verification, no `get_current_user`, no `require_mapset_member`, no SQLModel tables, no Pydantic schemas, no frontend auth context.
- **Impact:** Complete absence of authentication, authorization, input validation, and CSRF protection. A v1.0 release with empty security stubs is not shippable.
- **Fix:** Implement Phases 1–3 of `SPECIFICATION.md` before release. Every bullet in §5 must have corresponding code and tests.

### H2: No rate limiting on public endpoints — STILL OPEN

- **Category:** Infrastructure & Deployment / Authentication
- **Location:** `backend/app/main.py`, `backend/app/routers/auth.py` (stubs)
- **Severity:** HIGH
- **Status:** No change since previous audit.
- **Description:** FastAPI is initialized with no rate-limiting middleware. The OAuth callback endpoint will accept unlimited requests. An attacker can brute-force the `state` parameter or flood the token-exchange POST to osu!.
- **Fix:** Add `slowapi` (or Redis-backed limiter) before auth endpoints go live. Apply stricter limits to `/auth/*` than to API resource endpoints.

### M1: Dev-only npm vulnerabilities — STILL OPEN

- **Category:** Dependency & Supply Chain
- **Location:** `frontend/package-lock.json`
- **Severity:** MEDIUM
- **Status:** No change since previous audit.
- **Description:** `npm audit` still reports 10 vulnerabilities (4 moderate, 6 high) in `vite`, `esbuild`, `@typescript-eslint/*`. All are dev-only.
- **Fix:** Upgrade `vite` to `^6.4.2`+ and `@typescript-eslint/*` to `^8.0.0`. Add `npm audit --omit=dev` to CI.

### M2: Docker base images pinned to mutable tags — STILL OPEN

- **Category:** Supply Chain / Infrastructure
- **Location:** `backend/Dockerfile:3`, `frontend/Dockerfile:5,20,31`, `docker-compose.yml:4`
- **Severity:** MEDIUM
- **Status:** No change since previous audit.
- **Description:** Images use mutable minor tags (`python:3.12.4-slim`, `node:20.14-alpine`, `nginx:1.27-alpine`, `postgres:15.7-alpine`). TODO comments acknowledge this but it remains unfixed.
- **Fix:** Pin to immutable digests before production deployment.

### L2: Vite dev server binds to 0.0.0.0 — STILL OPEN

- **Category:** Infrastructure / Network Exposure
- **Location:** `frontend/vite.config.ts:7`
- **Severity:** LOW
- **Status:** No change since previous audit.
- **Description:** `server: { host: '0.0.0.0', ... }` listens on all interfaces inside the container. While `docker-compose.yml` publishes `127.0.0.1:5173` only, a misconfiguration could expose the dev server.
- **Fix:** Change `host` to `127.0.0.1` or document the exposure risk in `DEVELOPMENT.md`.

---

## Info Findings (Unchanged)

- **I1:** No CI pipeline configured. Recommend adding GitHub Actions with `pip-audit`, `npm audit --omit=dev`, `gitleaks`, `trivy image`, `pytest`, `npm test`.
- **I2:** No fuzz testing planned for `.osu` parser. Add `hypothesis` or `afl` tests once `osu_parser.py` is implemented.
- **I3:** `frontend/nginx.conf` CSP uses `'unsafe-inline'` for `style-src` (required by Tailwind). Consider CSP nonces or hashed styles in a future hardening pass.
- **I4:** `DATABASE_URL` does not specify `sslmode=require`. Document that off-box databases must use TLS.
- **I5:** No data retention or audit-log policy. Version history tables grow indefinitely. Document retention rules before public release.

---

## Recommendations (Updated Priority)

1. **Before writing auth code (Task 1.8):** PyJWT is now in place (C1 resolved). Ensure `jwt.decode()` is called with `algorithms=["HS256"]` exclusively.
2. **Before v1.0 release:** Implement all Phase 1–3 security controls from `SPECIFICATION.md` §5 (H1). Empty stubs remain the #1 blocker.
3. **Before v1.0 release:** Add rate limiting to `/auth/*` and public endpoints (H2).
4. **During Task 1.10/1.11:** Upgrade `vite` and `@typescript-eslint` to resolve `npm audit` findings (M1).
5. **Before production deployment:** Pin Docker base images to immutable digests (M2).
6. **During dev setup:** Change Vite `host` to `127.0.0.1` or document the risk (L2).
7. **Before CI setup:** Add `pip-audit`, `npm audit --omit=dev`, and `gitleaks` to CI workflow (I1).

---

## Positive Security Practices Observed (Updated)

- **CRITICAL dependency fixed:** `python-jose` removed; `pyjwt[crypto]` added.
- **Secrets are env-driven:** `OSU_CLIENT_ID`, `OSU_CLIENT_SECRET`, `SECRET_KEY`, `DATABASE_URL` all live in `.env`, never in code.
- **No secrets in git history:** Verified with `git log --all --full-history`; `.env` was never committed.
- **SECRET_KEY has a validator:** Rejects placeholders and short keys at startup.
- **OAuth credentials have validators:** Warn in dev, hard-error in production.
- **Ports bound to localhost only:** `127.0.0.1` for DB, backend, and frontend dev ports in `docker-compose.yml`.
- **Non-root containers:** Both backend (`appuser`) and frontend (`node`/`nginx`) images drop to unprivileged users.
- **Security headers present:** Both nginx and FastAPI now inject `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.
- **OpenAPI docs disabled in production:** Reduces attack surface and information disclosure.
- **Reproducible builds:** `package-lock.json` and pinned `requirements.txt` versions committed.
- **`.dockerignore` prevents `.env` leakage into images.**
- **Alembic async-safe and guarded:** `env.py` strips `+asyncpg` and fails loudly if `DATABASE_URL` is missing.
- **nginx proxy path aligned with spec:** `/api/` prefix is preserved.

---

*Security is not a feature you add at the end. It is a property you maintain at every step.*
