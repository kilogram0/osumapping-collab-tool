"""Unit tests for the per-user osu! API rate limiter."""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

import app.services.rate_limit as rl
from app.services.rate_limit import (
    OsuApiBannedError,
    OsuApiRateLimitedError,
    _IpRateLimiter,
    check_and_record_osu_api_call,
    check_oauth_callback_rate_limit,
    check_oauth_init_rate_limit,
)


@pytest.fixture(autouse=True)
def clean_state():
    rl._call_log.clear()
    rl._offense_count.clear()
    rl._ban_expires.clear()
    rl._permanent_bans.clear()
    rl._OAUTH_INIT_LIMITER._log.clear()
    rl._OAUTH_CALLBACK_LIMITER._log.clear()
    yield
    rl._call_log.clear()
    rl._offense_count.clear()
    rl._ban_expires.clear()
    rl._permanent_bans.clear()
    rl._OAUTH_INIT_LIMITER._log.clear()
    rl._OAUTH_CALLBACK_LIMITER._log.clear()


def _fill_window(uid, n=None):
    """Inject n (default _MAX_CALLS) recent timestamps into the call log."""
    count = n if n is not None else rl._MAX_CALLS
    rl._call_log[uid] = [datetime.now(timezone.utc)] * count


def _trigger_offense(uid):
    """Fill window and make one over-limit call; returns the raised exception."""
    _fill_window(uid)
    with pytest.raises(OsuApiRateLimitedError):
        check_and_record_osu_api_call(uid)


def _approx_days(uid, expected_days, tolerance_seconds=5) -> bool:
    ban_until = rl._ban_expires.get(uid)
    if ban_until is None:
        return False
    remaining = (ban_until - datetime.now(timezone.utc)).total_seconds()
    expected = timedelta(days=expected_days).total_seconds()
    return abs(remaining - expected) <= tolerance_seconds


# ---------------------------------------------------------------------------
# Normal operation
# ---------------------------------------------------------------------------


def test_calls_under_limit_are_recorded():
    uid = uuid4()
    for _ in range(rl._MAX_CALLS - 1):
        check_and_record_osu_api_call(uid)
    assert len(rl._call_log[uid]) == rl._MAX_CALLS - 1


def test_calls_outside_window_do_not_count():
    uid = uuid4()
    old = datetime.now(timezone.utc) - rl._WINDOW - timedelta(seconds=1)
    rl._call_log[uid] = [old] * rl._MAX_CALLS
    check_and_record_osu_api_call(uid)  # should not raise


def test_different_users_are_independent():
    uid_a, uid_b = uuid4(), uuid4()
    _fill_window(uid_a)
    with pytest.raises(OsuApiRateLimitedError):
        check_and_record_osu_api_call(uid_a)
    check_and_record_osu_api_call(uid_b)  # unaffected


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------


def test_exceeding_limit_raises_rate_limited():
    uid = uuid4()
    _fill_window(uid)
    with pytest.raises(OsuApiRateLimitedError):
        check_and_record_osu_api_call(uid)


def test_call_log_cleared_on_rate_limit_hit():
    """Call log is dropped when a ban is issued, freeing memory for dormant users."""
    uid = uuid4()
    _trigger_offense(uid)
    assert uid not in rl._call_log


def test_rate_limit_hit_raises_rate_limited_not_banned():
    """The call that triggers the ban raises OsuApiRateLimitedError, not OsuApiBannedError."""
    uid = uuid4()
    _fill_window(uid)
    with pytest.raises(OsuApiRateLimitedError):
        check_and_record_osu_api_call(uid)


# ---------------------------------------------------------------------------
# Escalating bans
# ---------------------------------------------------------------------------


def test_first_offense_bans_for_1_day():
    uid = uuid4()
    _trigger_offense(uid)
    assert _approx_days(uid, 1)
    assert rl._offense_count[uid] == 1


def test_second_offense_bans_for_3_days():
    uid = uuid4()
    _trigger_offense(uid)
    rl._ban_expires.clear()  # simulate ban expiry
    _trigger_offense(uid)
    assert _approx_days(uid, 3)
    assert rl._offense_count[uid] == 2


def test_third_offense_bans_for_7_days():
    uid = uuid4()
    rl._offense_count[uid] = 2
    _trigger_offense(uid)
    assert _approx_days(uid, 7)


def test_fourth_offense_bans_for_30_days():
    uid = uuid4()
    rl._offense_count[uid] = 3
    _trigger_offense(uid)
    assert _approx_days(uid, 30)


def test_fifth_offense_is_permanent():
    uid = uuid4()
    rl._offense_count[uid] = 4
    _trigger_offense(uid)
    assert uid in rl._permanent_bans
    assert uid not in rl._ban_expires


def test_sixth_and_beyond_offense_is_also_permanent():
    uid = uuid4()
    rl._offense_count[uid] = 99
    _trigger_offense(uid)
    assert uid in rl._permanent_bans


# ---------------------------------------------------------------------------
# Ban behaviour
# ---------------------------------------------------------------------------


def test_temporary_banned_user_raises_banned_error():
    uid = uuid4()
    rl._ban_expires[uid] = datetime.now(timezone.utc) + timedelta(hours=12)
    with pytest.raises(OsuApiBannedError):
        check_and_record_osu_api_call(uid)


def test_permanent_banned_user_raises_banned_error():
    uid = uuid4()
    rl._permanent_bans.add(uid)
    with pytest.raises(OsuApiBannedError):
        check_and_record_osu_api_call(uid)


def test_expired_ban_is_cleared_and_call_succeeds():
    uid = uuid4()
    rl._ban_expires[uid] = datetime.now(timezone.utc) - timedelta(seconds=1)
    rl._offense_count[uid] = 1
    check_and_record_osu_api_call(uid)  # should not raise
    assert uid not in rl._ban_expires


def test_offense_count_persists_through_ban_expiry():
    """Offense history is not wiped when a temporary ban expires."""
    uid = uuid4()
    rl._ban_expires[uid] = datetime.now(timezone.utc) - timedelta(seconds=1)
    rl._offense_count[uid] = 2
    check_and_record_osu_api_call(uid)  # clears ban
    assert rl._offense_count[uid] == 2  # still 2
    # Next violation should be the 3rd offense (7 days)
    _trigger_offense(uid)
    assert _approx_days(uid, 7)


# ---------------------------------------------------------------------------
# OAuth IP rate limiting
# ---------------------------------------------------------------------------


def test_ip_rate_limiter_allows_under_limit():
    limiter = _IpRateLimiter(timedelta(minutes=1), 3)
    assert limiter.is_allowed("1.2.3.4")
    assert limiter.is_allowed("1.2.3.4")
    assert limiter.is_allowed("1.2.3.4")


def test_ip_rate_limiter_blocks_at_limit():
    limiter = _IpRateLimiter(timedelta(minutes=1), 2)
    assert limiter.is_allowed("1.2.3.4")
    assert limiter.is_allowed("1.2.3.4")
    assert not limiter.is_allowed("1.2.3.4")


def test_ip_rate_limiter_is_per_ip():
    limiter = _IpRateLimiter(timedelta(minutes=1), 2)
    limiter.is_allowed("1.2.3.4")
    limiter.is_allowed("1.2.3.4")
    assert limiter.is_allowed("5.6.7.8")


def test_ip_rate_limiter_expired_window_resets():
    limiter = _IpRateLimiter(timedelta(seconds=0), 2)
    limiter.is_allowed("1.2.3.4")
    limiter.is_allowed("1.2.3.4")
    assert limiter.is_allowed("1.2.3.4")


def test_oauth_init_rate_limit_blocks_after_threshold():
    for _ in range(rl._OAUTH_INIT_LIMITER.max_calls):
        assert check_oauth_init_rate_limit("1.2.3.4")
    assert not check_oauth_init_rate_limit("1.2.3.4")


def test_oauth_callback_rate_limit_blocks_after_threshold():
    for _ in range(rl._OAUTH_CALLBACK_LIMITER.max_calls):
        assert check_oauth_callback_rate_limit("1.2.3.4")
    assert not check_oauth_callback_rate_limit("1.2.3.4")


def test_ip_rate_limiter_prunes_expired_entries():
    limiter = _IpRateLimiter(timedelta(minutes=1), 10)
    limiter.is_allowed("1.2.3.4")
    # Push the single timestamp outside the window without waiting.
    limiter._log["1.2.3.4"][0] = datetime.now(timezone.utc) - timedelta(minutes=2)
    # The next request triggers pruning and is allowed because the stale hit
    # no longer counts.
    assert limiter.is_allowed("1.2.3.4")
    assert len(limiter._log["1.2.3.4"]) == 1
    assert limiter._log["1.2.3.4"][0] > datetime.now(timezone.utc) - timedelta(seconds=1)


def test_ip_rate_limiter_evicts_oldest_when_cap_exceeded():
    limiter = _IpRateLimiter(timedelta(minutes=1), 10, max_ips=3)
    limiter.is_allowed("1.2.3.1")
    limiter.is_allowed("1.2.3.2")
    limiter.is_allowed("1.2.3.3")
    # Wait a tiny bit so the newest entry is clearly the latest.
    import time

    time.sleep(0.01)
    limiter.is_allowed("1.2.3.4")
    assert len(limiter._log) == 3
    assert "1.2.3.1" not in limiter._log
    assert "1.2.3.4" in limiter._log
