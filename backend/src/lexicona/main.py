from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from starlette.exceptions import HTTPException
from starlette.types import Scope

from lexicona.config import Settings
from lexicona.db import Database
from lexicona.deps import Db
from lexicona.routers import auth, training, words


class SpaFiles(StaticFiles):
    """Static files with index.html fallback for client-side routes."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except HTTPException as error:
            if error.status_code != 404 or path.startswith("api/") or path == "api":
                raise
            return await super().get_response("index.html", scope)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    database = Database(settings.database_url)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield
        await database.dispose()

    app = FastAPI(
        title="Lexicona", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json"
    )
    app.state.settings = settings
    app.state.db = database

    @app.middleware("http")
    async def no_store(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            # Private data must not end up in browser or proxy caches.
            response.headers["Cache-Control"] = "no-store"
        return response

    api = APIRouter(prefix="/api")

    @api.get("/health")
    async def health(db: Db) -> dict[str, str]:
        await db.execute(text("SELECT 1"))
        return {"status": "ok"}

    api.include_router(auth.router)
    api.include_router(words.router)
    api.include_router(training.router)
    app.include_router(api)

    if settings.static_dir is not None:
        app.mount("/", SpaFiles(directory=Path(settings.static_dir), html=True), name="spa")
    return app
