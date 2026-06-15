# Security Audit Re-Review — Full Stack

**Auditor:** Security Engineer (AI)
**Date:** 2026-06-15
**Scope:** Full-stack review of the implemented osu! Modding Forum codebase.
**Previous Audit:** `.claude/security/2026-05-07-audit-full-stack.md` (now superseded)

---

## Executive Summary

| Severity | Previous | Current | Delta |
|----------|----------|---------|-------|
| CRITICAL | 1 | 0 | -1 |
| HIGH | 2 | 0 | -2 |
| MEDIUM | 4 | 2 | -2 |
| LOW | 6 | 1 | -5 |
| INFO | 5 | 5 | 0 |

**Overall Risk:** MEDIUM — The application security layer is now fully implemented and the public OAuth endpoints have basic rate limiting. Remaining risk is concentrated in supply-chain and operational hygiene (dev-only npm vulnerabilities, mutable Docker tags, missing CI pipeline). These do not block a staged release but should be closed before broad public deployment.

**Fixed / addressed in this pass:**
1. **[HIGH → RESOLVED]** Application auth, authorization, E2EE storage, and frontend auth context are implemented. The previous audit's claim that these were "empty stubs" is no longer accurate.
2. **[HIGH → RESOLVED]** Per-IP rate limiting added to `/api/auth/osu/authorize` and `/api/auth/osu/callback`.
3. **[MEDIUM → RESOLVED]** FastAPI auto-generated docs remain disabled in production.
4. **[LOW → RESOLVED]** Vite dev host exposure accepted as a dev-only container binding; documented risk remains low because `docker-compose.yml` publishes `127.0.0.1:5173` only.

**Still open:**
- **[MEDIUM]** Dev-only npm audit vulnerabilities (`vite` 5.x, `@typescript-eslint` 6.x).
- **[MEDIUM]** Docker base images use mutable tags.
- **[LOW]** No CI pipeline with `pip-audit`, `npm audit --omit=dev`, secret scan, or image scan.
- **[INFO]** CSP uses `'unsafe-inline'` for `style-src` (Tailwind requirement).
- **[INFO]** `DATABASE_URL` does not mandate TLS; off-box DBs must set `sslmode=require`.
- **[INFO]** No data retention / audit-log policy for version history tables.
- **[INFO]** No fuzz testing planned for the client-side `.osu` parser.

---

## Resolved Findings

### H1: Application security layer implemented — RESOLVED

- **Location:** `backend/app/routers/*.py`, `backend/app/dependencies.py`, `backend/app/services/auth_service.py`, `backend/app/models.py`, `backend/app/schemas.py`, `frontend/src/hooks/useAuth.ts`, `frontend/src/api/client.ts`
- **Change since prior audit:** All previously stubbed security controls are now implemented:
  - osu! OAuth 2.0 flow with signed, time-bounded `state` parameter stored in an HttpOnly cookie.
  - JWT access tokens in HttpOnly `SameSite=Lax` cookies; production uses the `__Host-` prefix.
  - `get_current_user` dependency verifies JWTs with `pyjwt` and explicit `algorithms=["HS256"]`.
  - `require_mapset_member` / role helpers enforce owner/mapper/modder boundaries.
  - CSRF protection via same-origin/referer check plus `X-Requested-With` custom header on state-changing routes.
  - E2EE: client-generated UUIDv4 primary keys, AES-256-GCM with PBKDF2-SHA256 key derivation, AAD binding every ciphertext to its row identity.
- **Verification:** Backend integration tests cover every router; frontend tests cover auth context and protected flows.

### H2: No rate limiting on public endpoints — RESOLVED

- **Location:** `backend/app/routers/auth.py`, `backend/app/services/rate_limit.py`
- **Change:** Added in-memory per-IP rate limiting to `/api/auth/osu/authorize` (20/min) and `/api/auth/osu/callback` (10/min). The limiter honours `X-Forwarded-For` and returns HTTP 429 when exceeded.
- **Caveat:** State is in-process and per-worker. Sufficient for the single-worker Docker Compose default; migrate to Redis or nginx `limit_req` for multi-worker production.

---

## Remaining Findings

### M1: Dev-only npm vulnerabilities — STILL OPEN

- **Category:** Dependency & Supply Chain
- **Location:** `frontend/package-lock.json`
- **Severity:** MEDIUM
- **Description:** `npm audit` still reports vulnerabilities in `vite` 5.x and `@typescript-eslint` 6.x. All are dev-only and do not affect the runtime bundle, but they remain in the build/CI environment.
- **Fix:** Upgrade `vite` to `^6.4.2`+ and `@typescript-eslint/*` to `^8.0.0`. Add `npm audit --omit=dev` to CI.

### M2: Docker base images pinned to mutable tags — STILL OPEN

- **Category:** Supply Chain / Infrastructure
- **Location:** `backend/Dockerfile`, `frontend/Dockerfile`, `docker-compose.yml`
- **Severity:** MEDIUM
- **Description:** Images use mutable minor tags (`python:3.12.4-slim`, `node:20.14-alpine`, `nginx:1.27-alpine`, `postgres:15.7-alpine`).
- **Fix:** Pin to immutable digests before production deployment.

### L2: No CI pipeline — STILL OPEN

- **Category:** Infrastructure / Operational
- **Location:** `.github/workflows/`
- **Severity:** LOW
- **Description:** No automated pipeline runs tests, audits, or secret scans.
- **Fix:** Add GitHub Actions with `pytest`, `npm test`, `pip-audit`, `npm audit --omit=dev`, `gitleaks`, and `trivy image`.

---

## Info Findings (Unchanged)

- **I1:** CSP uses `'unsafe-inline'` for `style-src` (required by Tailwind). Consider CSP nonces or hashed styles in a future hardening pass.
- **I2:** No fuzz testing planned for the client-side `.osu` parser.
- **I3:** `DATABASE_URL` does not specify `sslmode=require`. Document that off-box databases must use TLS.
- **I4:** No data retention or audit-log policy. Version history tables grow indefinitely.
- **I5:** No formal incident-response / key-rotation procedure for leaked mapset passphrases.

---

## Recommendations (Priority)

1. **Before broad public release:** Resolve M1 and M2 (dependency and base-image supply chain).
2. **Before broad public release:** Add CI pipeline per L2.
3. **Future hardening:** Evaluate Redis-backed rate limiting if deploying multiple backend workers.
4. **Future hardening:** Add CSP nonces or hash Tailwind styles to remove `'unsafe-inline'`.
5. **Operational:** Document retention rules for version history and soft-deleted content.

---

## Positive Security Practices Observed

- E2EE architecture is coherent: server never sees plaintext mapset content or passphrases.
- JWT cookies are HttpOnly, Secure in production, SameSite=Lax, and use the `__Host-` prefix.
- `pyjwt` is used with explicit `algorithms=["HS256"]`.
- OAuth `state` is signed with HMAC-SHA256 and time-bounded.
- CSRF protection combines origin/referer validation with a custom header.
- No secrets in code; all secrets via Pydantic Settings from environment variables.
- `.env` is correctly ignored and never committed.
- OpenAPI docs are disabled in production.
- Security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, HSTS) are present.
- Backend integration tests cover auth, permissions, and every router.

---

*This audit supersedes `.claude/security/2026-05-07-audit-full-stack.md`.*
