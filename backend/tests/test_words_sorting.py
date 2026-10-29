from datetime import datetime

import pytest
from fastapi import FastAPI

from lexicona.db import Database
from lexicona.models import Word, WordTranslation
from tests.conftest import Client, add_word


async def seed(app: FastAPI, alice: Client) -> None:
    owner_id = (await alice.get("/api/auth/me")).json()["user"]["id"]
    rows = [
        ("a", "beta", "beta", 10, datetime(2025, 1, 1), "shared one"),
        ("b", "Alpha", "alpha", 30, datetime(2025, 1, 1), "shared two"),
        ("c", "alpha", "alpha", 10, datetime(2026, 1, 1), "shared three"),
        ("d", "gamma", "gamma", 30, datetime(2026, 1, 1), "other"),
    ]
    database: Database = app.state.db
    async with database.sessions() as db:
        for word_id, headword, normalized, progress, created_at, translation in rows:
            db.add(
                Word(
                    id=word_id,
                    owner_id=owner_id,
                    headword=headword,
                    normalized_headword=normalized,
                    progress=progress,
                    created_at=created_at,
                    translations=[
                        WordTranslation(position=0, text=translation, normalized_text=translation)
                    ],
                )
            )
        await db.commit()


@pytest.mark.parametrize(
    ("sort", "expected"),
    [
        ("created_desc", ["c", "d", "a", "b"]),
        ("created_asc", ["a", "b", "c", "d"]),
        ("headword_asc", ["b", "c", "a", "d"]),
        ("headword_desc", ["d", "a", "b", "c"]),
        ("progress_asc", ["a", "c", "b", "d"]),
        ("progress_desc", ["b", "d", "a", "c"]),
    ],
)
async def test_sorting_owner_search_and_ties(
    app: FastAPI, alice: Client, bob: Client, sort: str, expected: list[str]
) -> None:
    await seed(app, alice)
    other = await add_word(bob, "other", "shared four")
    result = await alice.get("/api/words", params={"sort": sort})
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert [word["id"] for word in result.json()] == expected
    assert other["id"] not in [word["id"] for word in result.json()]
    result = await alice.get("/api/words", params={"q": "SHARED", "sort": sort})
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert [word["id"] for word in result.json()] == [
        word_id for word_id in expected if word_id != "d"
    ]
    assert [word["id"] for word in (await bob.get("/api/words", params={"sort": sort})).json()] == [
        other["id"]
    ]


async def test_default_order_and_unknown_sort(app: FastAPI, alice: Client) -> None:
    await seed(app, alice)
    default = await alice.get("/api/words")
    explicit = await alice.get("/api/words", params={"sort": "created_desc"})
    assert default.status_code == 200 and default.json() == explicit.json()
    assert [word["id"] for word in default.json()] == ["c", "d", "a", "b"]
    for sort in ["", "created_at", "progress", "headword_asc; DROP TABLE words"]:
        result = await alice.get("/api/words", params={"sort": sort})
        assert result.status_code == 422
        assert result.headers["cache-control"] == "no-store"
    assert len((await alice.get("/api/words")).json()) == 4
