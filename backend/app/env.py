"""Central registry of environment variables.

This is the ONLY module in the backend that touches ``os.environ`` / ``os.getenv``.
All other code imports the already-extracted values from here.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env file when running outside Docker (e.g. bare-metal pytest).
# In Docker Compose the variables are already injected.
_env_path = Path(__file__).resolve().parent.parent.parent / ".env"
if _env_path.exists():
    load_dotenv(_env_path)


def _require(name: str) -> str:
    """Fetch a required env var and fail fast if it is missing or empty."""
    value = os.getenv(name)
    if value is None or value.strip() == "":
        raise RuntimeError(
            f"Required environment variable '{name}' is not set. "
            f"Ensure it is defined in your .env file or injected by your runtime."
        )
    return value


def _require_int(name: str, default: str) -> int:
    """Fetch an env var and coerce it to int; fail fast with a clear error on bad input."""
    raw = os.getenv(name, default)
    try:
        return int(raw)
    except ValueError as exc:
        raise RuntimeError(
            f"Environment variable '{name}' must be a valid integer, got: {raw!r}"
        ) from exc


# ------------------------------------------------------------------
# Required
# ------------------------------------------------------------------
DATABASE_URL: str = _require("DATABASE_URL")
OSU_CLIENT_ID: str = _require("OSU_CLIENT_ID")
OSU_CLIENT_SECRET: str = _require("OSU_CLIENT_SECRET")
SECRET_KEY: str = _require("SECRET_KEY")
FRONTEND_URL: str = _require("FRONTEND_URL")
BACKEND_URL: str = _require("BACKEND_URL")

# ------------------------------------------------------------------
# Optional (with defaults)
# ------------------------------------------------------------------
ACCESS_TOKEN_TTL_DAYS: int = _require_int("ACCESS_TOKEN_TTL_DAYS", "14")
ENVIRONMENT: str = os.getenv("ENVIRONMENT", "development").lower()

# Test database (optional — falls back to DATABASE_URL in test suite)
TEST_DATABASE_URL: str | None = os.getenv("TEST_DATABASE_URL")

# Postgres password (validated in production to avoid placeholder defaults)
POSTGRES_PASSWORD: str | None = os.getenv("POSTGRES_PASSWORD")
