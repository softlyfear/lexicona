from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from lexicona.cloze import mask_example
from lexicona.config import Settings
from lexicona.db import Database
from lexicona.main import create_app
from lexicona.models import Base, TrainingItem, TrainingSession, User, Word, WordProgress
from lexicona.routers.auth import throttle
from lexicona.security import hash_password

PASSWORD = "correct horse battery"


class Client(AsyncClient):
    csrf: str = ""

    async def login(self, login: str, password: str = PASSWORD) -> Any:
        response = await self.post("/api/auth/login", json={"login": login, "password": password})
        response.raise_for_status()
        self.csrf = response.json()["csrf_token"]
        self.headers["X-CSRF-Token"] = self.csrf
        return response.json()


@pytest.fixture
async def app(tmp_path: Path) -> AsyncIterator[FastAPI]:
    application = create_app(
        Settings(_env_file=None, database_url=f"sqlite+aiosqlite:///{tmp_path}/test.db")
    )
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


async def add_legacy_cloze_item(app: FastAPI, client: Client, word_id: str) -> dict[str, Any]:
    user = (await client.get("/api/auth/me")).json()["user"]
    database: Database = app.state.db
    async with database.sessions() as db:
        word = await db.get(Word, word_id)
        assert word is not None and word.owner_id == user["id"]
        schedule = await db.get(WordProgress, {"owner_id": user["id"], "word_id": word_id})
        assert schedule is not None
        prompt = mask_example(word.headword, word.example_en)
        assert prompt is not None
        session = TrainingSession(
            owner_id=user["id"],
            mode="cloze",
            direction="en_en",
            purpose="free",
            difficulty=user["difficulty"],
        )
        item = TrainingItem(
            word_id=word.id,
            word_content_version=word.content_version,
            word_training_version=word.training_version,
            word_progress_version=schedule.progress_version,
            position=0,
            prompt=prompt,
            options=[],
            expected_answers=[word.headword],
        )
        session.items.append(item)
        db.add(session)
        await db.commit()
        return {"id": item.id, "prompt": prompt, "options": []}


async def add_legacy_card_item(
    app: FastAPI, client: Client, word_id: str, direction: str = "en_ru", purpose: str = "free"
) -> dict[str, Any]:
    user = (await client.get("/api/auth/me")).json()["user"]
    database: Database = app.state.db
    async with database.sessions() as db:
        word = await db.get(Word, word_id)
        assert word is not None and word.owner_id == user["id"]
        schedule = await db.get(WordProgress, {"owner_id": user["id"], "word_id": word_id})
        assert schedule is not None
        prompt = word.headword if direction == "en_ru" else word.translations[0].text
        expected = [t.text for t in word.translations] if direction == "en_ru" else [word.headword]
        session = TrainingSession(
            owner_id=user["id"],
            mode="cards",
            direction=direction,
            purpose=purpose,
            difficulty=user["difficulty"],
        )
        item = TrainingItem(
            word_id=word.id,
            word_content_version=word.content_version,
            word_training_version=word.training_version,
            word_progress_version=schedule.progress_version,
            position=0,
            prompt=prompt,
            options=[],
            expected_answers=expected,
        )
        session.items.append(item)
        db.add(session)
        await db.commit()
        return {"id": item.id, "prompt": prompt, "options": []}
