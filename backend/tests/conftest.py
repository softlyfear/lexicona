from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from lexicona.config import Settings
from lexicona.db import Database
from lexicona.main import create_app
from lexicona.models import Base, User
from lexicona.routers.auth import throttle
from lexicona.security import hash_password

PASSWORD = "correct horse battery"


class Client(AsyncClient):
    """Test client that remembers the CSRF token after login."""

    csrf: str = ""

    async def login(self, login: str, password: str = PASSWORD) -> Any:
        response = await self.post("/api/auth/login", json={"login": login, "password": password})
        response.raise_for_status()
        self.csrf = response.json()["csrf_token"]
        self.headers["X-CSRF-Token"] = self.csrf
        return response.json()


@pytest.fixture
async def app(tmp_path: Path) -> AsyncIterator[FastAPI]:
    application = create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path}/test.db"))
    database: Database = application.state.db
    async with database.engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    throttle._failures.clear()
    yield application
    await database.dispose()


@pytest.fixture
def create_user(app: FastAPI) -> Callable[..., Awaitable[User]]:
    async def create(login: str, *, admin: bool = False) -> User:
        database: Database = app.state.db
        async with database.sessions() as db:
            user = User(login=login, password_hash=hash_password(PASSWORD), is_admin=admin)
            db.add(user)
            await db.commit()
            return user

    return create


def _client(app: FastAPI) -> Client:
    return Client(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
async def anon(app: FastAPI) -> AsyncIterator[Client]:
    async with _client(app) as client:
        yield client


@pytest.fixture
async def alice(app: FastAPI, create_user: Callable[..., Awaitable[User]]) -> AsyncIterator[Client]:
    await create_user("alice")
    async with _client(app) as client:
        await client.login("alice")
        yield client


@pytest.fixture
async def bob(app: FastAPI, create_user: Callable[..., Awaitable[User]]) -> AsyncIterator[Client]:
    await create_user("bob")
    async with _client(app) as client:
        await client.login("bob")
        yield client


async def add_word(client: AsyncClient, headword: str, *translations: str, **extra: Any) -> Any:
    response = await client.post(
        "/api/words", json={"headword": headword, "translations": list(translations), **extra}
    )
    assert response.status_code == 201, response.text
    return response.json()
