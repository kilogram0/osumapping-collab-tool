# Security Audit — Full Stack (Task 1.1 Skeleton + Fixes)

**Auditor:** Security Engineer (AI)
**Date:** 2026-05-07
**Scope:** Monorepo skeleton post-fixes — all configuration files, Dockerfiles, docker-compose.yml, nginx.conf, .gitignore, alembic, package.json, requirements.txt, and empty application stubs. No application logic (auth, DB models, API routes) exists yet.
**Commit:** Working tree after security-fix pass on task 1.1

---

## Executive Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 3 |
| LOW | 4 |
| INFO | 3 |

**Overall Risk:** LOW — The skeleton now has a sound security posture for bootstrap. Remaining findings are either known dependency CVEs in dev-only packages, infrastructure hardening that requires app code to be meaningful, or forward-looking recommendations for when auth lands.

**Key Findings:**
1. **[MEDIUM]** `npm audit` reports 10 vulnerabilities (4 moderate, 6 high) in `esbuild` and `minimatch` / `@typescript-eslint` dev-only packages. No production dependencies are affected.
2. **[MEDIUM]** Postgres `pg_isready` healthcheck in `docker-compose.yml` still hardcodes `osu` / `modding` credentials instead of using env vars.
3. **[MEDIUM]** Docker base images are pinned to minor versions, not immutable digests — acceptable for dev, but must be digest-pinned before production.
4. **[LOW]** `backend/alembic.ini` contains a placeholder URL that could confuse operators if they run `alembic` without `DATABASE_URL` set.
5. **[LOW]** No `.env` file validation at application startup yet — placeholder secrets could accidentally ship.
6. **[LOW]** `nginx:1.27-alpine` prod stage runs as `nginx` user, but `nginx.conf` listens on port 80 which requires `CAP_NET_BIND_SERVICE`; the `nginx` image handles this via `setcap`, but verify on target host.
7. **[LOW]** `docker-compose.yml` frontend service exposes Vite dev server without HTTPS; OAuth callbacks to `localhost` over HTTP are expected in dev, but `FRONTEND_URL` must switch to `https://` in production.

---

## Medium Findings

### M1: Dev-only npm vulnerabilities

- **Category:** Dependency / Supply Chain
- **Location:** `frontend/package-lock.json` — transitive deps of `vite`, `vitest`, `@typescript-eslint/*`
- **Severity:** MEDIUM
- **Description:**
  - `esbuild <= 0.24.2` (GHSA-67mh-4wv8-2f99): dev-server CORS bypass
  - `minimatch 9.0.0–9.0.6` (multiple GHSA): ReDoS in glob patterns
  These are all **dev-only** packages. The production image (`nginx:1.27-alpine`) does not contain Node, npm, or any of these packages.
- **Impact:** Development machine compromise risk if a malicious package is pulled; CI build poisoning if `npm install` runs in CI with the same vulnerable tree. Production image is unaffected.
- **Fix:**
  1. Upgrade `vite` to `^6.4.2` (or later) when Task 1.10/1.11 lands — this will pull a fixed `esbuild`.
  2. Upgrade `@typescript-eslint/*` to `^8.0.0` when updating ESLint config.
  3. Add `npm audit --omit=dev` to CI pipeline (INFO I1).
- **References:** GHSA-67mh-4wv8-2f99, GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74

### M2: Postgres healthcheck hardcodes credentials

- **Category:** Infrastructure / Secrets
- **Location:** `docker-compose.yml:16`
- **Severity:** MEDIUM
- **Description:** The healthcheck still uses `pg_isready -U osu -d modding` with literal strings, while `POSTGRES_USER` and `POSTGRES_DB` are now env-driven. If an operator changes `.env` values but forgets the healthcheck, the DB will never report healthy.
- **Impact:** Backend will not start (depends_on condition fails) with a silent, confusing failure.
- **Fix:** Use env interpolation in the healthcheck array. Unfortunately Docker Compose healthcheck `test:` does not support `${VAR}` inside JSON arrays directly. The standard workaround is a shell wrapper:
  ```yaml
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
  ```
  (Double `$$` escapes Compose interpolation so the shell sees `$POSTGRES_USER`.)

### M3: Docker images pinned by minor tag, not digest

- **Category:** Supply Chain
- **Location:** `backend/Dockerfile:3`, `frontend/Dockerfile:5,20,31`, `docker-compose.yml:4`
- **Severity:** MEDIUM
- **Description:** `python:3.12.4-slim`, `node:20.14-alpine`, `nginx:1.27-alpine`, `postgres:15.7-alpine` are mutable tags. The minor version reduces blast radius vs `latest`, but a tag retag or registry compromise can still silently change the image.
- **Impact:** Supply-chain compromise of build-time or runtime base images.
- **Fix:** Replace each tag with a digest:
  ```dockerfile
  FROM python:3.12.4-slim@sha256:<hexdigest>
  ```
  Use `docker buildx imagetools inspect python:3.12.4-slim` to get the current digest, commit it, and use Renovate/Dependabot to bump digests.
- **Status:** Acceptable for dev skeleton; flagged for production hardening checklist.

---

## Low Findings

### L1: Alembic placeholder URL is confusing

- **Category:** Configuration / UX
- **Location:** `backend/alembic.ini:7`
- **Severity:** LOW
- **Description:** `sqlalchemy.url = driver://user:pass@localhost/dbname` is a clear placeholder, but `alembic` will fail with a cryptic driver error if someone runs `alembic current` without `DATABASE_URL` exported. The failure mode is opaque.
- **Impact:** Developer friction; not a security issue directly, but misconfiguration risk.
- **Fix:** Keep the placeholder, but add a loud guard in `alembic/env.py`:
  ```python
  if not _db_url:
      raise RuntimeError(
          "DATABASE_URL environment variable is required. "
          "It is automatically set when running via docker-compose."
      )
  ```

### L2: No startup validation of SECRET_KEY

- **Category:** Secrets Management
- **Location:** `backend/app/config.py` (empty stub)
- **Severity:** LOW
- **Description:** The placeholder `SECRET_KEY=CHANGE_ME_...` is better than before, but `config.py` is still an empty file. There is no runtime check that rejects the placeholder.
- **Impact:** If a rushed operator copies `.env.example` to `.env` without changing the secret, the app will start and accept the weak key. JWT tokens will be trivially forgeable once auth code lands.
- **Fix:** When Task 1.4 implements `config.py`, add:
  ```python
  from pydantic import FieldValidator

  class Settings(BaseSettings):
      SECRET_KEY: str

      @field_validator("SECRET_KEY")
      def _reject_placeholder(cls, v: str) -> str:
          if v.startswith("CHANGE_ME") or len(v) < 32:
              raise ValueError(
                  "SECRET_KEY must be ≥ 32 characters and not the placeholder. "
                  "Generate one with: python -c 'import secrets; print(secrets.token_urlsafe(32))'"
              )
          return v
  ```

### L3: nginx prod stage port 80 privilege

- **Category:** Infrastructure
- **Location:** `frontend/Dockerfile:36-38`
- **Severity:** LOW
- **Description:** The `prod` stage runs as `USER nginx`, but nginx must bind port 80. The official `nginx:alpine` image grants `CAP_NET_BIND_SERVICE` to the nginx binary via `setcap`, so this works on most hosts. Some hardened kernels or seccomp profiles strip this capability.
- **Impact:** Container fails to start on hosts that disable `setcap` or run with strict seccomp.
- **Fix:** If this ever fails in production, switch to an unprivileged port (e.g., `listen 8080;`) and have the outer proxy (or host iptables) map 80→8080. Document this in `DEPLOYMENT.md`.

### L4: Vite dev server over HTTP

- **Category:** Transport Security
- **Location:** `docker-compose.yml:51`, `frontend/vite.config.ts`
- **Severity:** LOW
- **Description:** The dev container exposes port 5173 over plain HTTP. The spec §5 OAuth callback redirects to `FRONTEND_URL` which in dev is `http://localhost:5173`. This is correct for local dev, but the `SameSite=Lax` cookie will not be sent cross-scheme. Since dev backend is also HTTP, this is fine — both run on `localhost`. In production, `FRONTEND_URL` must be HTTPS and `Secure` cookie flag must be set.
- **Impact:** Misconfiguration risk if `FRONTEND_URL` is not updated to HTTPS in production.
- **Fix:** When `config.py` is written, make `Secure` conditional on `FRONTEND_URL.startswith("https://")` and log a warning at startup if production runs over HTTP.

---

## Info

- **I1:** No CI pipeline configured yet. Recommend adding GitHub Actions (or equivalent) with jobs for: `pip-audit`, `npm audit --omit=dev`, `gitleaks detect`, `trivy image`, `pytest`, `npm test`.
- **I2:** No `backend/tests/services/test_osu_parser.py` content yet — parser logic is empty. Once `.osu` parsing is implemented (Phase 3+), ensure the regex and file-size checks are fuzz-tested.
- **I3:** `frontend/nginx.conf` CSP uses `'unsafe-inline'` for `style-src`. This is required for Tailwind's inline critical CSS. Once the app is stable, consider generating a CSP nonce or hashing the inline styles to remove `'unsafe-inline'`.

---

## Recommendations (Priority Order)

1. **Before Task 1.4 (config.py):** Add startup validation for `SECRET_KEY` (L2). This is the single most important forward-looking fix because every auth feature depends on it.
2. **During Task 1.10/1.11 (frontend setup):** Upgrade `vite` and `@typescript-eslint` packages to resolve `npm audit` findings (M1). Add `npm audit --omit=dev` to any CI pipeline.
3. **Before production deployment:** Pin all Docker base images to immutable digests (M3). Add `pip-audit` and `trivy image` scans to CI.
4. **During Task 1.5 (Alembic setup):** Add the `DATABASE_URL` missing guard in `alembic/env.py` (L1) and fix the healthcheck env interpolation (M2).
5. **Before Phase 1 auth:** Ensure `Secure` cookie flag is conditional on HTTPS (L4).

---

## Positive Security Practices Observed

- **Secrets are env-driven:** `OSU_CLIENT_ID`, `OSU_CLIENT_SECRET`, `SECRET_KEY`, `DATABASE_URL` all live in `.env`, never in code.
- **No secrets in git history:** Single commit so far; placeholders are clearly placeholders.
- **Ports bound to localhost only:** `127.0.0.1` for DB, backend, and frontend dev ports in `docker-compose.yml`.
- **Non-root containers:** Both backend and frontend images drop to unprivileged users.
- **Security headers present:** `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `CSP` in nginx.
- **Reproducible builds:** `package-lock.json` and pinned `requirements.txt` versions committed.
- `.dockerignore` prevents `.env` and local artifacts from leaking into images.
- **Alembic async-safe:** `env.py` correctly handles `+asyncpg` driver stripping for sync migrations.

---

*Security is not a feature you add at the end. It is a property you maintain at every step.*
