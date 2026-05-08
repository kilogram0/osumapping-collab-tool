"""FastAPI application factory."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.config import settings
from app.database import engine


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
    # Disable auto-generated docs in production to reduce attack surface (M4).
    is_prod = settings.FRONTEND_URL.startswith("https://")
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
        allow_headers=["*"],
    )

    # Security headers on every response (L5)
    @app.middleware("http")
    async def add_security_headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response

    @app.get("/api/health", tags=["health"])
    async def health_check() -> dict:
        """Health check endpoint."""
        return {"status": "ok"}

    return app


app = create_app()
