"""FastAPI application factory."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.config import settings
from app.database import engine
from app.routers import auth


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Startup: verify database connectivity
    async with engine.connect() as conn:
        result = await conn.execute(text("SELECT 1"))
        if result.scalar() != 1:
            raise RuntimeError("Database connectivity check failed")
    yield
    # Shutdown
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

    return app


app = create_app()
