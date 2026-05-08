import pytest
from fastapi import HTTPException, Request
from starlette.datastructures import Headers

from app.dependencies import (
    generate_oauth_state,
    require_csrf_protection,
    require_custom_header,
    require_same_origin,
    validate_oauth_state,
)


class TestOAuthState:
    """M3(a) — signed state parameter for OAuth init."""

    def test_generate_returns_different_values_each_time(self):
        a = generate_oauth_state()
        b = generate_oauth_state()
        assert a != b
        assert len(a.split(":")) == 3

    def test_validate_returns_true_for_fresh_state(self):
        state = generate_oauth_state()
        assert validate_oauth_state(state) is True

    def test_validate_returns_false_for_tampered_state(self):
        state = generate_oauth_state()
        tampered = state[:-1] + ("0" if state[-1] != "0" else "1")
        assert validate_oauth_state(tampered) is False

    def test_validate_returns_false_for_expired_state(self, monkeypatch):
        import time

        original_time = time.time

        def frozen_time():
            return original_time() + 99999

        # Generate a state and then wind the clock forward
        state = generate_oauth_state()
        monkeypatch.setattr(time, "time", frozen_time)
        assert validate_oauth_state(state) is False

    def test_validate_returns_false_for_malformed_state(self):
        assert validate_oauth_state("not-a-state") is False
        assert validate_oauth_state("") is False


class TestRequireSameOrigin:
    """M3(b) — Origin / Referer validation."""

    async def _make_request(self, headers_dict=None):
        headers = Headers(headers_dict or {})
        scope = {
            "type": "http",
            "method": "POST",
            "headers": [(k.encode(), v.encode()) for k, v in (headers_dict or {}).items()],
        }
        return Request(scope)

    async def test_no_origin_or_referer_raises_403(self):
        """Strict by default: missing both headers is rejected."""
        req = await self._make_request({})
        with pytest.raises(HTTPException) as exc_info:
            await require_same_origin(req)
        assert exc_info.value.status_code == 403
        assert "Missing Origin or Referer" in exc_info.value.detail

    async def test_valid_origin_passes(self, monkeypatch):
        from app import dependencies

        monkeypatch.setattr(dependencies.settings, "FRONTEND_URL", "https://example.com")
        req = await self._make_request({"origin": "https://example.com"})
        await require_same_origin(req)

    async def test_invalid_origin_raises_403(self, monkeypatch):
        from app import dependencies

        monkeypatch.setattr(dependencies.settings, "FRONTEND_URL", "https://example.com")
        req = await self._make_request({"origin": "https://evil.com"})
        with pytest.raises(HTTPException) as exc_info:
            await require_same_origin(req)
        assert exc_info.value.status_code == 403

    async def test_valid_referer_passes(self, monkeypatch):
        from app import dependencies

        monkeypatch.setattr(dependencies.settings, "FRONTEND_URL", "https://example.com")
        req = await self._make_request({"referer": "https://example.com/dashboard"})
        await require_same_origin(req)

    async def test_invalid_referer_raises_403(self, monkeypatch):
        from app import dependencies

        monkeypatch.setattr(dependencies.settings, "FRONTEND_URL", "https://example.com")
        req = await self._make_request({"referer": "https://evil.com/phish"})
        with pytest.raises(HTTPException) as exc_info:
            await require_same_origin(req)
        assert exc_info.value.status_code == 403


class TestRequireCustomHeader:
    """M3(c) — custom request header validation."""

    async def test_missing_header_raises_403(self):
        with pytest.raises(HTTPException) as exc_info:
            await require_custom_header(None)
        assert exc_info.value.status_code == 403
        assert "X-Requested-With" in exc_info.value.detail

    async def test_present_header_passes(self):
        await require_custom_header("XMLHttpRequest")


class TestRequireCsrfProtection:
    """Combined CSRF guard."""

    async def _make_request(self, headers_dict=None):
        headers = Headers(headers_dict or {})
        scope = {
            "type": "http",
            "method": "POST",
            "headers": [(k.encode(), v.encode()) for k, v in (headers_dict or {}).items()],
        }
        return Request(scope)

    async def test_both_checks_must_pass(self, monkeypatch):
        from app import dependencies

        monkeypatch.setattr(dependencies.settings, "FRONTEND_URL", "https://example.com")
        req = await self._make_request({
            "origin": "https://example.com",
            "x-requested-with": "XMLHttpRequest",
        })
        # require_csrf_protection is a dependency function; we call it directly
        # in tests. In a router it would be injected via Depends().
        await require_csrf_protection(
            _same_origin=await require_same_origin(req),
            _custom_header=await require_custom_header("XMLHttpRequest"),
        )

    async def test_missing_origin_fails(self):
        with pytest.raises(HTTPException) as exc_info:
            await require_csrf_protection(
                _same_origin=await require_same_origin(
                    await self._make_request({"x-requested-with": "XMLHttpRequest"})
                ),
                _custom_header=await require_custom_header("XMLHttpRequest"),
            )
        assert exc_info.value.status_code == 403
        assert "Missing Origin or Referer" in exc_info.value.detail

    async def test_missing_custom_header_fails(self, monkeypatch):
        from app import dependencies

        monkeypatch.setattr(dependencies.settings, "FRONTEND_URL", "https://example.com")
        with pytest.raises(HTTPException) as exc_info:
            await require_csrf_protection(
                _same_origin=await require_same_origin(
                    await self._make_request({"origin": "https://example.com"})
                ),
                _custom_header=await require_custom_header(None),
            )
        assert exc_info.value.status_code == 403
        assert "X-Requested-With" in exc_info.value.detail
