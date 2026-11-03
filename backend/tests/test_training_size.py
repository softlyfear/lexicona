from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy import select

from lexicona.db import Database
from lexicona.models import TrainingItem, Word, WordTranslation
from tests.conftest import Client


async def seed(app: FastAPI, client: Client, count: int, *, excluded: bool = False) -> None:
    owner = (await client.get("/api/auth/me")).json()["user"]["id"]
    database: Database = app.state.db
    async with database.sessions() as db:
        db.add_all(
            [
                Word(
                    owner_id=owner,
                    headword=f"word{i}",
                    normalized_headword=f"word{i}",
                    progress=i,
                    is_excluded=excluded,
                    example_en=f"Example word{i}.",
                    translations=[
                        WordTranslation(
                            position=0, text=f"перевод{i}", normalized_text=f"перевод{i}"
                        )
                    ],
                )
                for i in range(count)
            ]
        )
        await db.commit()


@pytest.mark.parametrize("invalid", [0, -1, True, False, "3", "ALL", 3.0, 3.5, None])
async def test_size_rejects_invalid_json_types_and_bounds(alice: Client, invalid: Any) -> None:
    response = await alice.post(
        "/api/training/sessions", json={"mode": "input", "direction": "en_ru", "size": invalid}
    )
    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"


async def test_default_presets_and_partial_pool(app: FastAPI, alice: Client, bob: Client) -> None:
    await seed(app, alice, 155)
    await seed(app, bob, 4)
    default = await alice.post("/api/training/sessions", json={"mode": "input"})
    assert default.status_code == 201 and len(default.json()["items"]) == 10
    for size in [1, 50, 75, 100, 125, 150, 500, 501, 10**12]:
        response = await alice.post("/api/training/sessions", json={"mode": "input", "size": size})
        assert response.status_code == 201
        assert response.headers["cache-control"] == "no-store"
        items = response.json()["items"]
        assert len(items) == min(size, 155)
        assert {item["prompt"] for item in items} <= {f"word{i}" for i in range(155)}
        assert len({item["id"] for item in items}) == len(items)
    response = await bob.post("/api/training/sessions", json={"mode": "input", "size": 10**12})
    assert response.status_code == 201 and len(response.json()["items"]) == 4
    del alice.headers["X-CSRF-Token"]
    response = await alice.post("/api/training/sessions", json={"mode": "input", "size": 500})
    assert response.status_code == 403 and response.headers["cache-control"] == "no-store"


async def test_all_words_all_modes_no_duplicates(app: FastAPI, alice: Client, bob: Client) -> None:
    await seed(app, alice, 501)
    await seed(app, bob, 2)
    numeric = await alice.post("/api/training/sessions", json={"mode": "input", "size": 501})
    assert numeric.status_code == 201
    numeric_items = numeric.json()["items"]
    assert len(numeric_items) == len({item["prompt"] for item in numeric_items}) == 501
    for mode, direction in [
        ("input", "en_ru"),
        ("input", "ru_en"),
        ("choice", "en_ru"),
        ("choice", "ru_en"),
    ]:
        response = await alice.post(
            "/api/training/sessions", json={"mode": mode, "direction": direction, "size": "all"}
        )
        assert response.status_code == 201, (mode, direction, response.text)
        items = response.json()["items"]
        assert len(items) == 501
        assert len({item["id"] for item in items}) == 501
        database: Database = app.state.db
        async with database.sessions() as db:
            word_ids = list(
                await db.scalars(
                    select(TrainingItem.word_id).where(
                        TrainingItem.session_id == response.json()["id"]
                    )
                )
            )
        assert len(word_ids) == len(set(word_ids)) == 501
        assert len({item["prompt"] for item in items}) == 501
        assert all(set(item) == {"id", "prompt", "options"} for item in items)
        assert all(len(item["options"]) == (6 if mode == "choice" else 0) for item in items)


async def test_excluded_pools_remain_unavailable(app: FastAPI, alice: Client, bob: Client) -> None:
    await seed(app, alice, 3, excluded=True)
    await seed(app, bob, 5)
    for mode, direction in [
        ("input", "en_ru"),
        ("choice", "en_ru"),
    ]:
        response = await alice.post(
            "/api/training/sessions", json={"mode": mode, "direction": direction, "size": 500}
        )
        assert response.status_code == 409
        assert response.headers["cache-control"] == "no-store"
        assert response.json()["detail"] == "not_enough_words"
