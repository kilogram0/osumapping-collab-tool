# /plan — Feature Planning & Specification

> **Role:** Tech Lead managing a team of senior engineers.
> **Goal:** Produce an exhaustive, unambiguous implementation specification that any senior engineer or coding agent can execute without making important decisions themselves.
> **Output:** A markdown instruction file in `.claude/plans/YYYY-MM-DD-feature-name.md`.

---

## Invocation

The user describes a feature they want built. Example:
> `/plan "Add Google Calendar event syncing with conflict resolution UI"`

---

## Phase 1: Discovery & Constraint Gathering

You are a **tech lead** with a reputation for shipping features that don't break in production. Before writing a single line of the plan, you **must** gather context. Do not assume. Do not infer preferences. Ask.

Read these files silently before asking questions:
- `CLAUDE.md`
- `.claude/rules/backend.md`
- `.claude/rules/frontend.md`
- `README.md`
- `docker-compose.yml`
- `backend/go.mod`
- `frontend/package.json`
- Any existing plans in `.claude/plans/` to avoid contradictions

Then, ask the user a series of clarifying questions. Present them as a numbered list. **Do not proceed to Phase 2 until all questions are answered.**

### Mandatory Question Categories

For every feature, you must get clarity on:

#### 1. Scope & Boundaries
- What exactly is in scope? What is explicitly out of scope?
- Is this a greenfield feature or modifying existing code?
- Are there existing designs, mocks, or user stories?
- What is the minimum viable version? What can be deferred to v2?

#### 2. Data & State
- What new data models or database tables are needed?
- What is the source of truth for this data?
- How does data flow between frontend and backend?
- Are there real-time requirements (WebSockets, SSE, polling)?
- What is the expected data volume? (affects pagination, indexing)

#### 3. User Experience
- What does the user see and do? Walk through the happy path step by step.
- What are the error states? (network failure, auth failure, validation failure, empty state)
- What are the loading states?
- Is this feature behind a feature flag?
- What devices / viewports must be supported?

#### 4. Authorization & Security
- Who can access this feature? (all users, authenticated users, admins)
- Are there new permissions or roles?
- Does this touch PII, OAuth tokens, or sensitive data?
- What audit logging is required?

#### 5. API Contract
- What new endpoints are needed? (method, path, request shape, response shape)
- What existing endpoints change?
- Are there breaking changes to the API? If so, how is versioning handled?
- What is the error response format?

#### 6. Integration Points
- Does this integrate with external APIs? (Google Calendar, etc.)
- What are the rate limits and failure modes of those APIs?
- Are there webhook or callback requirements?
- Does this require new environment variables or secrets?

#### 7. Performance & Scale
- What is the expected latency budget for user-facing operations?
- Are there background jobs or async processing needs?
- What are the caching requirements?
- How does this behave under load?

#### 8. Testing & Quality
- What is the testing strategy? (unit, integration, e2e)
- Are there specific edge cases that must be tested?
- What is the rollout plan? (feature flag, gradual rollout, canary)
- What monitoring and alerting is needed?

#### 9. Dependencies & Timeline
- Are new third-party dependencies acceptable? (Go modules, npm packages)
- Are there hard deadlines or dependencies on other teams/features?
- What is the estimated complexity? (S, M, L, XL)

### Example Questionnaire

```
Before I write the implementation plan, I need to clarify a few things:

1. **Scope:** You mentioned "Google Calendar event syncing." Does this include
   bidirectional sync (write back to Google) or read-only sync? Is deleting
   events in our app supposed to delete them in Google Calendar?

2. **Data Model:** Should we store a copy of every Google event in our Postgres,
   or only events the user explicitly "links" to our app? What fields do we need
   to persist vs. fetch on-the-fly?

3. **UX:** When the user opens the sync page, do they see a list of their Google
   calendars to pick from, or do we auto-sync all calendars? What does the
   conflict resolution UI look like when an event changes in both places?

4. **Auth:** Do we need additional Google OAuth scopes beyond what we already
   request? If so, how do we handle re-consent for existing users?

5. **API:** Should the sync happen on-demand (button click), automatically
   (background job), or both? If background, what triggers it — cron, webhook,
   or user action?

6. **Performance:** How many events are we targeting per user? 10? 10,000?
   This affects whether we can load everything into memory or need pagination.

7. **Testing:** Do you want integration tests that hit the real Google Calendar
   API, or should we mock it? (Real API tests are flaky and rate-limited.)

8. **Out of scope:** Are there any related features you explicitly do NOT want
   in this PR? (e.g., recurring event support, attendee management, color coding)
```

**Important:**
- If the user's initial description is vague, ask broad questions first, then drill down.
- If the user gives a very specific description, still confirm assumptions with targeted questions.
- Never say "I assume X." Always ask.
- Present questions in a format that is easy to answer (bullet points, multiple choice where appropriate).

---

## Phase 2: Research & Feasibility

Once questions are answered, perform silent research:

1. **Check existing code** for similar patterns. How was auth implemented? How are stores structured? How does the router handle similar flows?
2. **Check PrimeVue docs** for relevant components. Is there a scheduler, data table feature, or calendar component that fits?
3. **Check Google API docs** if integrating. What are the exact endpoints, quotas, and error codes?
4. **Check Go ecosystem** for relevant libraries. (But prefer stdlib per rules.)
5. **Identify risks.** What is most likely to go wrong? Rate limits? OAuth scope changes? Large data volumes?

Document any feasibility concerns in the plan under a "Risks & Mitigations" section.

---

## Phase 3: Write the Implementation Plan

Create a markdown file at `.claude/plans/YYYY-MM-DD-{kebab-case-feature-name}.md`.

This document must be **human-readable** (clear prose) but also **machine-executable** (precise enough that a coding agent could implement it without asking clarifying questions).

### Required Sections

#### 1. Overview

One paragraph: what this feature does, who it's for, and why it matters.

#### 2. Goals & Non-Goals

**Goals:** (Numbered, specific, testable)
1. Users can view their Google Calendar events in our app.
2. Users can manually trigger a sync from the UI.
3. The backend stores synced events in Postgres.

**Non-Goals:** (Explicitly out of scope to prevent scope creep)
1. Bidirectional sync (write to Google) — deferred to v2.
2. Real-time sync via webhooks — out of scope.
3. Mobile-native app support — out of scope.

#### 3. User Flow

Describe the happy path in numbered steps from the user's perspective:
1. User navigates to `/calendar`.
2. Frontend fetches `/api/calendars`.
3. User selects a calendar and clicks "Sync Now."
4. Frontend POSTs `/api/calendars/{id}/sync`.
5. Backend fetches events from Google Calendar API.
6. Backend stores events in `calendar_events` table.
7. Frontend polls `/api/sync-jobs/{jobId}` until complete.
8. Frontend displays the synced events in a PrimeVue DataTable.

#### 4. API Specification

For every new or modified endpoint, provide:

```markdown
##### `POST /api/calendars/{id}/sync`

- **Auth:** Required. Session cookie.
- **Rate limit:** 1 per 30 seconds per user.
- **Request body:** None
- **Path params:**
  - `id` (string, UUID): The calendar ID.
- **Response 202 Accepted:**
  ```json
  {
    "jobId": "uuid",
    "status": "queued",
    "estimatedDurationSeconds": 15
  }
  ```
- **Response 409 Conflict:**
  ```json
  {
    "error": "sync already in progress",
    "jobId": "uuid"
  }
  ```
- **Response 429 Too Many Requests:**
  ```json
  {
    "error": "rate limit exceeded",
    "retryAfterSeconds": 23
  }
  ```
- **Errors:** All errors use `httpx.WriteJSON` with the request-scoped logger.
```

#### 5. Data Model

Provide SQL DDL (Goose migration) and Go structs:

```sql
-- migrations/0002_calendar_events.sql
-- +goose Up
CREATE TABLE calendar_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    google_event_id TEXT NOT NULL,
    calendar_id UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    description TEXT,
    location TEXT,
    raw_json JSONB NOT NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, google_event_id)
);

CREATE INDEX idx_calendar_events_user_time ON calendar_events(user_id, start_time);

-- +goose Down
DROP TABLE calendar_events;
```

```go
// internal/calendar/types.go
type Event struct {
    ID            uuid.UUID `json:"id" db:"id"`
    UserID        uuid.UUID `json:"userId" db:"user_id"`
    GoogleEventID string    `json:"googleEventId" db:"google_event_id"`
    CalendarID    uuid.UUID `json:"calendarId" db:"calendar_id"`
    Summary       string    `json:"summary" db:"summary"`
    StartTime     time.Time `json:"startTime" db:"start_time"`
    EndTime       time.Time `json:"endTime" db:"end_time"`
    Description   *string   `json:"description,omitempty" db:"description"`
    Location      *string   `json:"location,omitempty" db:"location"`
    RawJSON       json.RawMessage `json:"-" db:"raw_json"`
    SyncedAt      time.Time `json:"syncedAt" db:"synced_at"`
    CreatedAt     time.Time `json:"createdAt" db:"created_at"`
    UpdatedAt     time.Time `json:"updatedAt" db:"updated_at"`
}
```

#### 6. Backend Architecture

Describe the Go packages, files, and functions to create or modify:

```markdown
##### New Files
- `internal/calendar/service.go`
  - `type Service struct { ... }`
  - `func NewService(...)`
  - `func (s *Service) SyncCalendar(ctx context.Context, userID, calendarID uuid.UUID) (uuid.UUID, error)`
  - `func (s *Service) ListEvents(ctx context.Context, userID uuid.UUID, start, end time.Time) ([]Event, error)`

- `internal/calendar/google.go`
  - `type GoogleClient interface { ... }` (port for testing)
  - `type googleClient struct { ... }` (adapter)

- `internal/store/store.go` (modify)
  - Add `EventRepo` interface

- `internal/store/postgres/events.go`
  - `func (s *Store) CreateEvent(ctx context.Context, e *Event) error`
  - `func (s *Store) ListEventsByUser(ctx context.Context, userID uuid.UUID, start, end time.Time) ([]Event, error)`

##### Modified Files
- `internal/httpx/router.go`: Add routes `/api/calendars/...`
- `docker-compose.yml`: Add `SYNC_RATE_LIMIT` env var to `.env.example`
```

#### 7. Frontend Architecture

Describe the Vue components, stores, and routes:

```markdown
##### New Files
- `src/views/CalendarView.vue`
  - Uses PrimeVue DataTable to list events.
  - Sync button with loading state.
- `src/stores/calendar.ts`
  - `useCalendarStore` with `events`, `isSyncing`, `sync()` action.
- `src/composables/useSyncJob.ts`
  - Polls `/api/sync-jobs/{jobId}` with exponential backoff.

##### Modified Files
- `src/router/index.ts`: Add `/calendar` route.
- `src/App.vue`: Add Calendar link to nav.
```

#### 8. Error Handling & Edge Cases

List every error scenario and how it must be handled:

```markdown
| Scenario | Backend Behavior | Frontend Behavior |
|----------|-----------------|-------------------|
| Google API rate limited | Return 503, log warning, set retry header | Show "Google is busy" toast, enable retry button |
| User revokes Google OAuth | Return 401, clear session | Redirect to login, show re-auth message |
| Sync job already running | Return 409 with existing jobId | Show "Sync in progress", poll existing job |
| Zero events returned | Return 200 with empty array | Show empty state illustration |
| Database timeout | Return 500, log error | Show generic error, allow retry |
```

#### 9. Testing Strategy

```markdown
##### Unit Tests
- `internal/calendar/service_test.go`: Test `SyncCalendar` with mocked `GoogleClient` and `EventRepo`.
- `src/stores/calendar.spec.ts`: Test store actions with mocked API.

##### Integration Tests
- `internal/store/postgres/events_integration_test.go`: Test `ListEventsByUser` with real Postgres.

##### Component Tests
- `src/views/__tests__/CalendarView.spec.ts`: Test sync button click, loading state, table render.

##### Manual Tests
1. Connect Google account with 0 calendars → verify empty state.
2. Connect with 5000 events → verify pagination and performance.
3. Revoke OAuth mid-sync → verify graceful failure.
```

#### 10. Security & Privacy

```markdown
- New endpoint requires authenticated session.
- Users can only access their own events (enforce `user_id` filter in every query).
- Google event data stored in `raw_json` is treated as opaque; never log it.
- Rate limit sync endpoint to prevent abuse.
- PII (summary, description, location) is encrypted at rest if required by compliance.
```

#### 11. Deployment & Ops

```markdown
- Add migration file to `backend/migrations/`.
- Add env vars to `.env.example`.
- Update `docker-compose.yml` if new services needed.
- Update `frontend/nginx.conf` if new routes need proxying.
- Update README with user-facing instructions.
- Add metrics: `calendar_sync_total`, `calendar_sync_duration_seconds`.
```

#### 12. Risks & Mitigations

```markdown
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Google API rate limits | High | Medium | Exponential backoff, user-facing retry UI |
| Large calendar sync timeouts | Medium | High | Background job + polling, not synchronous request |
| OAuth scope rejection | Low | High | Graceful degradation, prompt for re-consent |
```

#### 13. Open Questions

If any questions remain unanswered after the user's input, list them here. Do not leave ambiguities.

#### 14. Task Breakdown (Implementation Order)

```markdown
1. **Backend: Migration & types** (1 PR)
   - Write Goose migration
   - Define `Event` struct and `EventRepo` interface

2. **Backend: Store implementation** (same PR or next)
   - Implement `postgres.EventRepo`
   - Integration tests

3. **Backend: Google client** (1 PR)
   - `GoogleClient` interface and adapter
   - Unit tests with HTTP mock

4. **Backend: Service & handlers** (1 PR)
   - `calendar.Service`
   - HTTP handlers and router wiring
   - Rate limiting middleware

5. **Frontend: Store & API client** (1 PR)
   - `useCalendarStore`
   - API functions

6. **Frontend: UI** (1 PR)
   - `CalendarView.vue`
   - Router, nav link
   - Component tests

7. **Integration & E2E** (1 PR)
   - End-to-end manual testing
   - README updates
```

**Rules for task breakdown:**
- One concern per PR. Do not bundle unrelated changes.
- Backend-first, then frontend. The frontend needs a working API.
- Migrations always ship before code that depends on them.
- Each task must be small enough for a single focused code review.

---

## Phase 4: Validation

Before presenting the plan to the user:

1. **Read it as if you were the implementer.** Is anything ambiguous? Any missing imports? Any undefined types?
2. **Check against rules.** Does it violate `.claude/rules/backend.md` or `.claude/rules/frontend.md`?
3. **Check against conventions.** Does it respect `CLAUDE.md` (PrimeVue, chi, docker compose, nginx proxy)?
4. **Ensure every decision is documented.** If the plan says "use polling," explain why polling was chosen over WebSockets or webhooks.

If you find gaps, go back to the user with follow-up questions. **A plan with ambiguity is worse than no plan.**

---

## Example Output File Structure

`.claude/plans/2026-05-05-google-calendar-sync.md`

---

*Remember: Your job is to think so the implementer doesn't have to. Every decision, every edge case, every error response, every database index must be specified. The only thing left for the implementer is to write the code.*
