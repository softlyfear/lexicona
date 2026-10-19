"""ASGI application factory; no implicit schema changes."""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from lexicona.database import DEFAULT_DATABASE_URL, Database


class ErrorDetail(BaseModel):
    code: Literal["not_ready"] = "not_ready"
    message: Literal["Service is not ready"] = "Service is not ready"


class ErrorEnvelope(BaseModel):
    error: ErrorDetail


class Ready(BaseModel):
    status: Literal["ready"] = "ready"


def create_app(database_url: str | None = None) -> FastAPI:
    """Build an isolated application instance without running migrations."""
    database = Database(
        database_url
        if database_url is not None
        else os.environ.get("LEXICONA_DATABASE_URL", DEFAULT_DATABASE_URL)
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await database.dispose()

    app = FastAPI(title="Lexicona", version="0.1.0", lifespan=lifespan)

    @app.get("/api/v1/health/live")
    async def live(response: Response) -> dict[str, str]:
        response.headers["Cache-Control"] = "no-store"
        return {"status": "alive"}

    @app.get(
        "/api/v1/health/ready",
        response_model=Ready,
        responses={503: {"model": ErrorEnvelope}},
    )
    async def ready(response: Response) -> Ready | JSONResponse:
        response.headers["Cache-Control"] = "no-store"
        if not await database.is_ready():
            return JSONResponse(
                status_code=503,
                content=ErrorEnvelope(error=ErrorDetail()).model_dump(),
                headers={"Cache-Control": "no-store", "Retry-After": "1"},
            )
        return Ready()

    return app
