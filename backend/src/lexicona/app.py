"""ASGI application factory; no implicit schema changes."""

import logging
import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import datetime
from time import monotonic
from typing import Literal
from uuid import UUID, uuid4

from fastapi import FastAPI, Request, Response
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException
from starlette.routing import Match, Route

from lexicona.auth.bootstrap import utc_now
from lexicona.auth.boundary import AuthBoundary
from lexicona.auth.config import AuthConfig, token
from lexicona.auth.errors import AuthError, decision, error_response
from lexicona.auth.http import LoginPasswords, RejectScopedSlashes, router
from lexicona.auth.invite_http import router as invite_router
from lexicona.auth.passwords import Hasher
from lexicona.auth.rates import Rates
from lexicona.auth.sessions import Sessions
from lexicona.database import DEFAULT_DATABASE_URL, Database


class ErrorDetail(BaseModel):
    code: Literal["not_ready"] = "not_ready"
    message: Literal["Service is not ready"] = "Service is not ready"


class ErrorEnvelope(BaseModel):
    error: ErrorDetail


class Ready(BaseModel):
    status: Literal["ready"] = "ready"


def create_app(
    database_url: str | None = None,
    *,
    auth_config: AuthConfig | None = None,
    clock: Callable[[], datetime] = utc_now,
    ids: Callable[[], UUID] = uuid4,
    tokens: Callable[[], str] = token,
    password_hasher: Hasher | None = None,
    rate_clock: Callable[[], float] = monotonic,
) -> FastAPI:
    """Build an isolated application instance without running migrations."""
    database = Database(
        database_url
        if database_url is not None
        else os.environ.get("LEXICONA_DATABASE_URL", DEFAULT_DATABASE_URL)
    )

    config = auth_config if auth_config is not None else AuthConfig()
    rates = Rates(rate_clock)
    passwords = LoginPasswords(password_hasher)
    sessions = Sessions(database, clock=clock, ids=ids, tokens=tokens)
    logging.getLogger("aiosqlite").setLevel(logging.WARNING)
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            await passwords.start()
            yield
        finally:
            try:
                await passwords.close()
            finally:
                await database.dispose()

    app = FastAPI(title="Lexicona", version="0.1.0", lifespan=lifespan)
    auth_routes = router(sessions, config, rates, passwords)
    invite_routes = invite_router(sessions, config, passwords, rates)

    @app.exception_handler(HTTPException)
    async def routing_error(request: Request, error: HTTPException) -> Response:
        if "auth_decision" not in request.scope:
            return await http_exception_handler(request, error)
        headers = dict(error.headers or {})
        if error.status_code == 405:
            # The router reports only its first partial match, not the whole target.
            methods: set[str] = set()
            for route in (*auth_routes.routes, *invite_routes.routes):
                if isinstance(route, Route):
                    match, _ = route.matches(request.scope)
                    if match == Match.PARTIAL:
                        methods.update(route.methods or ())
            headers["Allow"] = ", ".join(sorted(methods))
        return error_response(
            AuthError(
                "method_not_allowed" if error.status_code == 405 else "not_found",
                headers=headers,
            ),
            decision(request),
        )

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

    app.add_middleware(RejectScopedSlashes)
    app.add_middleware(AuthBoundary, rates=rates)
    app.include_router(auth_routes)
    app.include_router(invite_routes)
    return app
