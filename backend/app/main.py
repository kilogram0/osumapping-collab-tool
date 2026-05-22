"""FastAPI application factory."""

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import delete as sa_delete, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.config import settings
from app.database import engine
from app.models import Mapset, MapsetMember
from app.queries import GHOST_GRACE_DAYS
from app.routers import auth, difficulties, mapsets, members, posts, sections

logger = logging.getLogger(__name__)

_CLEANUP_INTERVAL_SECONDS = 3600


async def _purge_expired_mapsets(db_engine: AsyncEngine | None = None) -> None:
    """Delete all mapsets whose delete_at has passed.

    Assumed to run in a single-worker deployment. In a multi-worker setup each
    worker will run its own copy (idempotent, but wasteful). For production
    scale prefer pg_cron, a k8s CronJob, or a dedicated worker process.
    Timestamps are naive UTC — all app containers must run in UTC.

    Pass db_engine to override the default app engine (used in tests).
    """
    async with AsyncSession(db_engine or engine) as session:
        await session.execute(
            sa_delete(Mapset).where(
                Mapset.delete_at <= datetime.now(timezone.utc).replace(tzinfo=None)
            )
        )
        await session.commit()


async def _purge_expired_ghost_memberships(db_engine: AsyncEngine | None = None) -> None:
    """Delete MapsetMember rows whose kicked grace period has expired."""
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=GHOST_GRACE_DAYS)
    async with AsyncSession(db_engine or engine) as session:
        await session.execute(
            sa_delete(MapsetMember).where(
                MapsetMember.kicked_at.is_not(None),
                MapsetMember.kicked_at <= cutoff,
            )
        )
        await session.commit()


async def _cleanup_expired_mapsets() -> None:
    while True:
        try:
            await _purge_expired_mapsets()
            await _purge_expired_ghost_memberships()
        except Exception:
            logger.exception("Error during scheduled mapset cleanup")
        await asyncio.sleep(_CLEANUP_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Startup: verify database connectivity
    async with engine.connect() as conn:
        result = await conn.execute(text("SELECT 1"))
        if result.scalar() != 1:
            raise RuntimeError("Database connectivity check failed")
    cleanup_task = asyncio.create_task(_cleanup_expired_mapsets())
    yield
    # Shutdown
    cleanup_task.cancel()
    await engine.dispose()


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    # Disable auto-generated docs in production to reduce attack surface.
    is_prod = settings.is_prod
    app = FastAPI(
        title="osu! Modding Forum API",
        description="Private modding forum for osu! mappers",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/api/docs" if not is_prod else None,
        redoc_url="/api/redoc" if not is_prod else None,
        openapi_url="/api/openapi.json" if not is_prod else None,
    )

    # CORS — must allow credentials for cookie-based auth
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.FRONTEND_URL],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=[
            "Content-Type",
            "Authorization",
            "X-Requested-With",
            "X-CSRF-Token",
        ],
    )

    # Security headers on every response
    @app.middleware("http")
    async def add_security_headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        if settings.is_https:
            response.headers["Strict-Transport-Security"] = (
                "max-age=63072000; includeSubDomains"
            )
        return response

    @app.get("/api/health/live", tags=["health"])
    async def health_live() -> dict:
        """Liveness probe — process is up."""
        return {"status": "ok"}

    @app.get("/api/health/ready", tags=["health"])
    async def health_ready() -> dict:
        """Readiness probe — dependencies (database) are reachable."""
        try:
            async with engine.connect() as conn:
                result = await conn.execute(text("SELECT 1"))
                if result.scalar() != 1:
                    raise RuntimeError("DB health check failed")
        except Exception:
            return {"status": "unavailable"}
        return {"status": "ok"}

    # Mount routers — all routes live under /api per the API contract
    app.include_router(auth.router, prefix="/api")
    app.include_router(mapsets.router, prefix="/api")
    app.include_router(members.router, prefix="/api")
    app.include_router(difficulties.router, prefix="/api")
    app.include_router(sections.router, prefix="/api")
    app.include_router(posts.router, prefix="/api")

    return app


app = create_app()
