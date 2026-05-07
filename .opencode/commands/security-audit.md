# /security-audit — Security Engineer

> **Role:** Application Security Engineer performing a focused security review.
> **Goal:** Identify vulnerabilities, misconfigurations, and risky patterns before they reach production.
> **Output:** A markdown security audit report in `.claude/security/YYYY-MM-DD-audit-{scope}.md`.

---

## Invocation

The user provides a scope for the audit.

> `/security-audit "Full stack audit before v1.0 release"`
> `/security-audit "Backend auth flow only"`
> `/security-audit "Review PR #42 for security issues"`

---

## Audit Categories

Perform a systematic review across these categories. Do not skip any.

### 1. Authentication & Session Management

- [ ] Are session secrets cryptographically strong (≥ 32 bytes entropy)?
- [ ] Are sessions invalidated on the server side (not just client-side cookie deletion)?
- [ ] Is session expiration enforced?
- [ ] Are OAuth state parameters cryptographically random and validated?
- [ ] Are OAuth codes exchanged securely (POST to token endpoint, no code in URL)?
- [ ] Is PKCE used for OAuth public clients? (if applicable)
- [ ] Are refresh tokens rotated on use?
- [ ] Is brute-force protection implemented on login endpoints?

### 2. Authorization

- [ ] Does every endpoint verify the user's identity?
- [ ] Are resource-level access controls enforced? (User A cannot see User B's data)
- [ ] Are admin endpoints separated and protected?
- [ ] Is there any insecure direct object reference (IDOR)? (e.g., `/api/events/123` without checking ownership)
- [ ] Are CORS policies restrictive? No `Access-Control-Allow-Origin: *` with credentials.

### 3. Data Protection

- [ ] Is PII encrypted at rest? (database-level or application-level)
- [ ] Are database connections encrypted? (`sslmode=require` when off-box)
- [ ] Are backups encrypted?
- [ ] Is sensitive data excluded from logs? (passwords, tokens, PII)
- [ ] Are error messages generic to users but detailed in logs?
- [ ] Is there a data retention policy?

### 4. Input Validation & Injection

- [ ] Are all user inputs validated (type, length, format, range)?
- [ ] Is SQL constructed via parameterized queries exclusively?
- [ ] Are command injections prevented? (no `exec`, `system`, `os/exec` with user input)
- [ ] Are path traversals prevented? (no `../` in file paths)
- [ ] Are XSS vectors prevented? (no `v-html` with user content, no unescaped output)
- [ ] Is CSRF protection implemented for state-changing operations?

### 5. HTTP & Transport Security

- [ ] Are security headers present? (`X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`)
- [ ] Is HSTS enabled?
- [ ] Are cookies `HttpOnly`, `Secure`, and `SameSite`?
- [ ] Is TLS 1.2+ enforced?
- [ ] Are secrets transmitted only over HTTPS?

### 6. Secrets Management

- [ ] Are secrets in environment variables, never in code?
- [ ] Is `.env` in `.gitignore` and `.dockerignore`?
- [ ] Are Docker image tags pinned? (prevents supply chain attacks)
- [ ] Are base images minimal? (distroless, no shell)
- [ ] Is there any secret in git history? (check with `git log -S` or `gitleaks`)

### 7. Dependency & Supply Chain

- [ ] Are dependencies scanned for known CVEs? (`govulncheck`, `npm audit`)
- [ ] Are dependencies pinned in `go.mod` / `package-lock.json`?
- [ ] Are unused dependencies removed?
- [ ] Is there any dependency on unmaintained or suspicious packages?

### 8. Infrastructure & Deployment

- [ ] Is the backend port exposed to the internet directly? (Should be nginx-only)
- [ ] Are container privileges minimal? (non-root user, read-only filesystem where possible)
- [ ] Is there a health check that doesn't expose sensitive info?
- [ ] Are logs aggregated securely? No secrets in log streams.
- [ ] Is there a rate limiter on public endpoints?

### 9. Business Logic

- [ ] Are there race conditions in multi-step operations? (e.g., check-then-act)
- [ ] Are there time-of-check to time-of-use (TOCTOU) vulnerabilities?
- [ ] Can users perform actions they shouldn't? (delete others' data, escalate privileges)
- [ ] Are there any bypass paths around intended workflows?

---

## Severity Ratings

| Severity | Definition | Action Required |
|----------|-----------|-----------------|
| **CRITICAL** | Exploitable vulnerability leading to data breach, RCE, or full compromise. | Fix immediately. Do not deploy. |
| **HIGH** | Significant weakness that could lead to privilege escalation or data exposure. | Fix before release. |
| **MEDIUM** | Defense-in-depth issue or weakness requiring unusual conditions to exploit. | Fix in next sprint. |
| **LOW** | Best practice deviation with minimal practical risk. | Address when convenient. |
| **INFO** | Observation or recommendation for future hardening. | Document. |

---

## Output Format

Write findings to `.claude/security/YYYY-MM-DD-audit-{scope}.md`.

```markdown
# Security Audit — {Scope}

**Auditor:** Security Engineer (AI)  
**Date:** YYYY-MM-DD  
**Scope:** {files, PR, or full stack}  
**Commit:** {sha if applicable}  

---

## Executive Summary

- **CRITICAL:** 0
- **HIGH:** 1
- **MEDIUM:** 3
- **LOW:** 5
- **INFO:** 2

**Overall Risk:** {LOW / MEDIUM / HIGH / CRITICAL}

**Key Findings:**
1. [HIGH] Missing rate limiting on `/auth/google/callback` enables brute-force of OAuth state tokens.
2. [MEDIUM] `middleware.RealIP` trust assumption is not documented in nginx config comment.
3. ...

---

## Critical Findings

### C1: {Title}

- **Category:** Authentication
- **Location:** `backend/internal/auth/google.go:45`
- **Severity:** CRITICAL
- **Description:** The OAuth state parameter is generated using `math/rand` instead of `crypto/rand`, making it predictable.
- **Impact:** An attacker can forge the state parameter and perform CSRF attacks against the OAuth flow.
- **Proof of Concept:**
  ```go
  // Vulnerable code
  state := fmt.Sprintf("%d", rand.Intn(1e9))
  ```
- **Fix:**
  ```go
  import "crypto/rand"

  b := make([]byte, 16)
  if _, err := rand.Read(b); err != nil {
      return "", fmt.Errorf("generate state: %w", err)
  }
  state := base64.URLEncoding.EncodeToString(b)
  ```
- **References:** CWE-338, OWASP OAuth Cheat Sheet

---

## High Findings

### H1: {Title}
...

---

## Medium Findings

### M1: {Title}
...

---

## Low Findings

### L1: {Title}
...

---

## Recommendations

1. Implement rate limiting on all `/auth/*` endpoints before public release.
2. Add `Content-Security-Policy` headers in nginx.
3. Run `govulncheck ./...` and `npm audit` in CI on every PR.
4. ...

---

## Positive Security Practices Observed

- Secrets are loaded from environment variables, not hardcoded.
- Distroless runtime image reduces attack surface.
- Session secrets require ≥ 32 bytes of entropy.
```

---

## Tools to Run (if available)

When performing an audit, run these tools and include their output:

```bash
# Go
 govulncheck ./...
 go vet ./...
 staticcheck ./...

# Frontend
 npm audit
 npx better-npm-audit audit

# Secrets scanning (if installed)
 gitleaks detect --source . --verbose

# General
 docker scan <image>  # or trivy image <image>
```

---

*Security is not a feature you add at the end. It is a property you maintain at every step.*
