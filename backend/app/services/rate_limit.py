"""Per-user rate limiting and ban tracking for osu! API lookup calls.

State is in-process and per-worker.  Sufficient for the default
single-worker Docker Compose deployment; migrate to Redis for multi-worker.
"""

from datetime import datetime, timedelta, timezone
from uuid import UUID

_WINDOW = timedelta(minutes=30)
_MAX_CALLS = 50

# Escalating ban duration indexed by offense number (0-based).
# The last entry applies to all subsequent offenses.
_BAN_DURATIONS: list[timedelta | None] = [
    timedelta(days=1),   # 1st offense
    timedelta(days=3),   # 2nd offense
    timedelta(days=7),   # 3rd offense
    timedelta(days=30),  # 4th offense
    None,                # 5th+ offense: permanent
]

# user_id -> timestamps of recent osu! API calls within the current window
_call_log: dict[UUID, list[datetime]] = {}

# user_id -> lifetime offense count (never decremented)
_offense_count: dict[UUID, int] = {}

# user_id -> temporary ban expiry
_ban_expires: dict[UUID, datetime] = {}

# users with a permanent ban
_permanent_bans: set[UUID] = set()


class OsuApiRateLimitedError(Exception):
    """User exceeded the per-window osu! API lookup limit."""


class OsuApiBannedError(Exception):
    """User is banned from osu! API fallback lookups."""


def check_and_record_osu_api_call(user_id: UUID) -> None:
    """Gate an osu! API lookup for *user_id*.

    Raises :class:`OsuApiBannedError` if the user is currently banned.
    Raises :class:`OsuApiRateLimitedError` if they exceed *_MAX_CALLS* within
    *_WINDOW*; records an offense and applies an escalating ban each time.
    Records the call timestamp on success.
    """
    now = datetime.now(timezone.utc)

    if user_id in _permanent_bans:
        raise OsuApiBannedError()

    ban_until = _ban_expires.get(user_id)
    if ban_until is not None:
        if now < ban_until:
            raise OsuApiBannedError()
        del _ban_expires[user_id]  # expired — clear it, keep offense count

    window_start = now - _WINDOW
    recent = [t for t in _call_log.get(user_id, []) if t > window_start]

    if len(recent) >= _MAX_CALLS:
        count = _offense_count.get(user_id, 0) + 1
        _offense_count[user_id] = count
        # Drop the call log entirely: the ban duration always exceeds the window,
        # so these timestamps will be stale on re-entry.  This also prevents a
        # full window from persisting in memory for users who never return.
        _call_log.pop(user_id, None)
        duration = _BAN_DURATIONS[min(count - 1, len(_BAN_DURATIONS) - 1)]
        if duration is None:
            _permanent_bans.add(user_id)
        else:
            _ban_expires[user_id] = now + duration
        raise OsuApiRateLimitedError()

    recent.append(now)
    _call_log[user_id] = recent
