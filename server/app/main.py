"""Kadra Server — необязательный бэкенд: аккаунты, хранение проектов и медиа.

Запуск: uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from . import __version__
from .config import get_settings
from .db import init_engine
from .routes import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_engine()
    yield


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="Kadra Server", version=__version__, lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        allow_credentials=False,  # авторизация — Bearer-токеном, cookies не используются
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"],
        allow_headers=["Authorization", "Content-Type", "Range"],
        expose_headers=["Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition"],
        max_age=86400,
    )
    app.add_middleware(GZipMiddleware, minimum_size=2048)

    @app.get("/api/health", tags=["service"])
    def health():
        return {"status": "ok", "name": "kadra-server", "version": __version__, "registration": s.allow_registration}

    app.include_router(router)

    # Необязательно: раздавать фронтенд с того же сервиса (FRONTEND_DIR=../web)
    if s.frontend_dir and Path(s.frontend_dir).is_dir():
        app.mount("/", StaticFiles(directory=s.frontend_dir, html=True), name="frontend")
    return app


app = create_app()
