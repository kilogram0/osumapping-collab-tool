import importlib
import os
from unittest.mock import patch

import pytest
from pydantic import ValidationError


class TestProductionDetection:
    """M1 — production behavior must gate on ENVIRONMENT, not is_https."""

    def _reload_settings(self, monkeypatch, **env_vars):
        """Reload env.py and config.py with the given env vars."""
        for key, value in env_vars.items():
            monkeypatch.setenv(key, value)
        # Ensure required vars are present
        for key in ["DATABASE_URL", "SECRET_KEY", "FRONTEND_URL", "BACKEND_URL",
                    "OSU_CLIENT_ID", "OSU_CLIENT_SECRET"]:
            if key not in env_vars:
                monkeypatch.setenv(key, env_vars.get(key, "default_value_for_tests"))

        import app.env as env_module
        importlib.reload(env_module)

        import app.config as config_module
        importlib.reload(config_module)
        return config_module.settings

    def test_is_prod_is_true_when_environment_is_production(self, monkeypatch):
        settings = self._reload_settings(
            monkeypatch,
            DATABASE_URL="postgresql+asyncpg://u:p@h:5432/db_test",
            SECRET_KEY="a" * 32,
            FRONTEND_URL="https://example.com",
            BACKEND_URL="https://api.example.com",
            OSU_CLIENT_ID="real_id_123",
            OSU_CLIENT_SECRET="real_secret_456",
            ENVIRONMENT="production",
            POSTGRES_PASSWORD="strong_password_123",
            TEST_DATABASE_URL="",
        )
        assert settings.is_prod is True
        assert settings.is_https is True
        assert settings.cookie_secure is True
        assert settings.cookie_name == "__Host-access_token"

    def test_is_prod_is_false_when_environment_is_development(self, monkeypatch):
        settings = self._reload_settings(
            monkeypatch,
            DATABASE_URL="postgresql+asyncpg://u:p@h:5432/db_test",
            SECRET_KEY="a" * 32,
            FRONTEND_URL="http://localhost:5173",
            BACKEND_URL="http://localhost:8000",
            OSU_CLIENT_ID="real_id_123",
            OSU_CLIENT_SECRET="real_secret_456",
            ENVIRONMENT="development",
            TEST_DATABASE_URL="",
        )
        assert settings.is_prod is False
        assert settings.is_https is False
        assert settings.cookie_secure is False
        assert settings.cookie_name == "access_token"

    def test_production_with_http_frontend_fails_fast(self, monkeypatch):
        """Production + HTTP FRONTEND_URL must raise at startup."""
        with pytest.raises(ValidationError) as exc_info:
            self._reload_settings(
                monkeypatch,
                DATABASE_URL="postgresql+asyncpg://u:p@h:5432/db_test",
                SECRET_KEY="a" * 32,
                FRONTEND_URL="http://insecure.example.com",
                BACKEND_URL="http://api.example.com",
                OSU_CLIENT_ID="real_id_123",
                OSU_CLIENT_SECRET="real_secret_456",
                ENVIRONMENT="production",
                TEST_DATABASE_URL="",
            )

        errors = exc_info.value.errors()
        assert any("FRONTEND_URL" in str(e) for e in errors)
        assert any("HTTPS" in str(e) for e in errors)

    def test_https_in_dev_does_not_enable_production_mode(self, monkeypatch):
        """HTTPS frontend in dev must NOT disable docs or switch to __Host-."""
        settings = self._reload_settings(
            monkeypatch,
            DATABASE_URL="postgresql+asyncpg://u:p@h:5432/db_test",
            SECRET_KEY="a" * 32,
            FRONTEND_URL="https://localhost:5173",
            BACKEND_URL="https://localhost:8000",
            OSU_CLIENT_ID="real_id_123",
            OSU_CLIENT_SECRET="real_secret_456",
            ENVIRONMENT="development",
            TEST_DATABASE_URL="",
        )
        assert settings.is_prod is False
        assert settings.is_https is True
        assert settings.cookie_secure is True
        assert settings.cookie_name == "__Host-access_token"


class TestPostgresPasswordValidator:
    """L4 — POSTGRES_PASSWORD must not be a default in production."""

    def _reload_settings(self, monkeypatch, **env_vars):
        for key, value in env_vars.items():
            monkeypatch.setenv(key, value)
        for key in ["DATABASE_URL", "SECRET_KEY", "FRONTEND_URL", "BACKEND_URL",
                    "OSU_CLIENT_ID", "OSU_CLIENT_SECRET"]:
            if key not in env_vars:
                monkeypatch.setenv(key, env_vars.get(key, "default_value_for_tests"))

        import app.env as env_module
        importlib.reload(env_module)

        import app.config as config_module
        importlib.reload(config_module)
        return config_module.settings

    def test_default_password_in_production_fails(self, monkeypatch):
        with pytest.raises(ValidationError) as exc_info:
            self._reload_settings(
                monkeypatch,
                DATABASE_URL="postgresql+asyncpg://u:p@h:5432/db_test",
                SECRET_KEY="a" * 32,
                FRONTEND_URL="https://example.com",
                BACKEND_URL="https://api.example.com",
                OSU_CLIENT_ID="real_id_123",
                OSU_CLIENT_SECRET="real_secret_456",
                ENVIRONMENT="production",
                POSTGRES_PASSWORD="osu",
                TEST_DATABASE_URL="",
            )

        errors = exc_info.value.errors()
        assert any("POSTGRES_PASSWORD" in str(e) for e in errors)

    def test_change_me_password_in_production_fails(self, monkeypatch):
        with pytest.raises(ValidationError) as exc_info:
            self._reload_settings(
                monkeypatch,
                DATABASE_URL="postgresql+asyncpg://u:p@h:5432/db_test",
                SECRET_KEY="a" * 32,
                FRONTEND_URL="https://example.com",
                BACKEND_URL="https://api.example.com",
                OSU_CLIENT_ID="real_id_123",
                OSU_CLIENT_SECRET="real_secret_456",
                ENVIRONMENT="production",
                POSTGRES_PASSWORD="CHANGE_ME_123",
                TEST_DATABASE_URL="",
            )

        errors = exc_info.value.errors()
        assert any("POSTGRES_PASSWORD" in str(e) for e in errors)

    def test_strong_password_in_production_passes(self, monkeypatch):
        settings = self._reload_settings(
            monkeypatch,
            DATABASE_URL="postgresql+asyncpg://u:p@h:5432/db_test",
            SECRET_KEY="a" * 32,
            FRONTEND_URL="https://example.com",
            BACKEND_URL="https://api.example.com",
            OSU_CLIENT_ID="real_id_123",
            OSU_CLIENT_SECRET="real_secret_456",
            ENVIRONMENT="production",
            POSTGRES_PASSWORD="super_secret_password_123",
            TEST_DATABASE_URL="",
        )
        assert settings.POSTGRES_PASSWORD == "super_secret_password_123"

    def test_default_password_in_development_warns(self, monkeypatch):
        settings = self._reload_settings(
            monkeypatch,
            DATABASE_URL="postgresql+asyncpg://u:p@h:5432/db_test",
            SECRET_KEY="a" * 32,
            FRONTEND_URL="http://localhost:5173",
            BACKEND_URL="http://localhost:8000",
            OSU_CLIENT_ID="real_id_123",
            OSU_CLIENT_SECRET="real_secret_456",
            ENVIRONMENT="development",
            POSTGRES_PASSWORD="osu",
            TEST_DATABASE_URL="",
        )
        assert settings.POSTGRES_PASSWORD == "osu"
