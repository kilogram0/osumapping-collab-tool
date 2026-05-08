import pytest

from app.env import _require, _require_int


class TestRequire:
    """Unit tests for the env-var _require helper."""

    def test_missing_var_raises(self, monkeypatch):
        monkeypatch.delenv("___FAKE_MISSING_VAR___", raising=False)
        with pytest.raises(RuntimeError) as exc_info:
            _require("___FAKE_MISSING_VAR___")
        assert "___FAKE_MISSING_VAR___" in str(exc_info.value)
        assert "not set" in str(exc_info.value)

    def test_empty_var_raises(self, monkeypatch):
        monkeypatch.setenv("___FAKE_EMPTY_VAR___", "")
        with pytest.raises(RuntimeError) as exc_info:
            _require("___FAKE_EMPTY_VAR___")
        assert "___FAKE_EMPTY_VAR___" in str(exc_info.value)

    def test_whitespace_only_raises(self, monkeypatch):
        monkeypatch.setenv("___FAKE_WS_VAR___", "   ")
        with pytest.raises(RuntimeError) as exc_info:
            _require("___FAKE_WS_VAR___")
        assert "___FAKE_WS_VAR___" in str(exc_info.value)

    def test_present_var_returns_value(self, monkeypatch):
        monkeypatch.setenv("___FAKE_OK_VAR___", "hello")
        assert _require("___FAKE_OK_VAR___") == "hello"


class TestRequireInt:
    """Unit tests for the env-var _require_int helper."""

    def test_valid_int_returns_value(self, monkeypatch):
        monkeypatch.setenv("___FAKE_INT___", "42")
        assert _require_int("___FAKE_INT___", "0") == 42

    def test_missing_uses_default(self, monkeypatch):
        monkeypatch.delenv("___FAKE_MISSING_INT___", raising=False)
        assert _require_int("___FAKE_MISSING_INT___", "7") == 7

    def test_non_numeric_raises_runtime_error(self, monkeypatch):
        monkeypatch.setenv("___FAKE_BAD_INT___", "not-a-number")
        with pytest.raises(RuntimeError) as exc_info:
            _require_int("___FAKE_BAD_INT___", "0")
        assert "___FAKE_BAD_INT___" in str(exc_info.value)
        assert "must be a valid integer" in str(exc_info.value)
        assert "not-a-number" in str(exc_info.value)
