"""Application settings loaded from environment variables."""

import logging
import os

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    """Pydantic settings model.

    All secrets are injected via environment variables. Never commit
    real values to version control.
    """

    # Database
    DATABASE_URL: str

    # osu! OAuth
    OSU_CLIENT_ID: str
    OSU_CLIENT_SECRET: str

    # Security
    SECRET_KEY: str

    # URLs
    FRONTEND_URL: str
    BACKEND_URL: str

    # Token lifetime
    ACCESS_TOKEN_TTL_DAYS: int = 14

    # ------------------------------------------------------------------
    # Validators
    # ------------------------------------------------------------------
    @field_validator("SECRET_KEY")
    @classmethod
    def _reject_placeholder_secret(cls, v: str) -> str:
        if v.startswith("CHANGE_ME") or len(v) < 32:
            raise ValueError(
                "SECRET_KEY must be ≥ 32 characters and not the placeholder. "
                "Generate one with: python -c 'import secrets; print(secrets.token_urlsafe(32))'"
            )
        return v

    @field_validator("OSU_CLIENT_ID", "OSU_CLIENT_SECRET")
    @classmethod
    def _reject_placeholder_oauth(cls, v: str) -> str:
        if v.startswith("your_") or len(v) < 10:
            if os.environ.get("ENVIRONMENT", "development").lower() == "production":
                raise ValueError(
                    "OAuth credentials must be real values, not placeholders. "
                    "Set them in your .env file."
                )
            logger.warning(
                "OAuth credentials are placeholders. "
                "Authentication will not work until real values are set."
            )
        return v

    # ------------------------------------------------------------------
    # Computed cookie properties
    # ------------------------------------------------------------------
    @property
    def cookie_name(self) -> str:
        """Production uses __Host- prefix which requires Secure + Path=/.

        Dev uses the plain name because localhost is HTTP.
        """
        return "__Host-access_token" if self.is_https else "access_token"

    @property
    def cookie_secure(self) -> bool:
        """Secure flag is True when the frontend is served over HTTPS."""
        return self.is_https

    @property
    def cookie_samesite(self) -> str:
        """Lax works because frontend and backend share a registrable domain."""
        return "Lax"

    @property
    def is_https(self) -> bool:
        return self.FRONTEND_URL.startswith("https://")

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
    )


# Singleton instance exported to the application
settings = Settings()

# --------------------------------------------------------------------------
# Forward-looking runtime warning (L4)
# --------------------------------------------------------------------------
if os.environ.get("ENVIRONMENT", "development").lower() == "production":
    if not settings.is_https:
        logger.warning(
            "FRONTEND_URL is HTTP in a production environment. "
            "OAuth callbacks and auth cookies may break. "
            "Set FRONTEND_URL to https:// in production."
        )
