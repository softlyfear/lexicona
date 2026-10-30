from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy import select

from lexicona.db import Database
from lexicona.models import TrainingItem, TrainingSession, Word
from tests.conftest import Client, add_word
from tests.test_words import set_progress


@pytest.mark.parametrize(
    "field,value",
    [
        ("size", "ALL"),
        ("tag_ids", None),
        ("tag_ids", [""]),
        ("tag_ids", ["a" * 33]),
        ("tag_ids", [1]),
        ("tag_ids", ["x"] * 21),
        ("progress_min", True),
        ("progress_max", 3.0),
        ("progress_min", -1),
        ("progress_max", "100"),
    ],
)
async def test_invalid_inputs(alice: Client, field: str, value: Any) -> None:
    response = await alice.post("/api/training/sessions", json={"mode": "input", field: value})
    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"


async def test_filters_choice_ownership_and_snapshot(
    app: FastAPI, alice: Client, bob: Client, anon: Client
) -> None:
    target = await add_word(alice, "cat", "кот", tags=["animals", "selected"])
    await add_word(alice, "dog", "собака", tags=["animals"])
    await add_word(alice, "cow", "корова")
    await add_word(alice, "fox", "лиса")
    excluded = await add_word(alice, "owl", "сова")
    await alice.patch(f"/api/words/{excluded['id']}/training", json={"is_excluded": True})
    foreign = await add_word(bob, "secret", "тайна", tags=["private"])
    await set_progress(app, target["id"], 158)
    ids = [t["id"] for t in target["tags"]]
    request = {
        "mode": "choice",
        "size": "all",
        "tag_ids": [*ids, ids[0]],
        "progress_min": 158,
        "progress_max": 158,
    }
    response = await alice.post("/api/training/sessions", json=request)
    assert response.status_code == 201
    items = response.json()["items"]
    assert len(items) == 1 and items[0]["prompt"] == "cat"
    assert set(items[0]["options"]) == {"кот", "собака", "корова", "лиса"}
    for tag in (foreign["tags"][0]["id"], "missing"):
        response = await alice.post("/api/training/sessions", json={"tag_ids": [tag]})
        assert response.status_code == 404 and response.json()["detail"] == "tag_not_found"
    assert (
        await alice.post("/api/training/sessions", json={"progress_min": 159, "progress_max": 158})
    ).status_code == 422
    assert (await alice.post("/api/training/sessions", json={"progress_min": 10**50})).json()[
        "detail"
    ] == "no_matching_words"
    assert (await anon.post("/api/training/sessions", json={})).status_code == 401
    alice.headers.pop("X-CSRF-Token")
    assert (await alice.post("/api/training/sessions", json={})).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    await alice.put(
        f"/api/words/{target['id']}", json={"headword": "cat", "translations": ["кот"], "tags": []}
    )
    await set_progress(app, target["id"], 200)
    database: Database = app.state.db
    async with database.sessions() as db:
        item = await db.get(TrainingItem, items[0]["id"])
        assert item is not None
        option = item.correct_option
    first = await alice.post(
        f"/api/training/items/{items[0]['id']}/answer", json={"option": option}
    )
    replay = await alice.post(
        f"/api/training/items/{items[0]['id']}/answer", json={"option": option}
    )
    assert first.status_code == 200 and first.json()["progress"] == 204
    assert replay.json() == first.json()


async def test_filtered_empty_does_not_create_session(app: FastAPI, alice: Client) -> None:
    await add_word(alice, "word", "слово")
    response = await alice.post("/api/training/sessions", json={"mode": "input", "progress_min": 1})
    assert response.status_code == 409 and response.json()["detail"] == "no_matching_words"
    database: Database = app.state.db
    async with database.sessions() as db:
        assert (await db.scalars(select(TrainingSession))).all() == []
        assert (await db.scalars(select(TrainingItem))).all() == []
        assert len((await db.scalars(select(Word))).all()) == 1


async def test_inclusive_progress_boundaries_and_large_integers(
    app: FastAPI, alice: Client
) -> None:
    for value in (0, 100, 101, 158, 200):
        word = await add_word(alice, f"word{value}", f"перевод{value}")
        await set_progress(app, word["id"], value)
    cases = [
        ({}, {0, 100, 101, 158, 200}),
        ({"progress_min": 100}, {100, 101, 158, 200}),
        ({"progress_max": 101}, {0, 100, 101}),
        ({"progress_min": 0, "progress_max": 0}, {0}),
        ({"progress_min": 101, "progress_max": 158}, {101, 158}),
        ({"progress_min": 158, "progress_max": 158}, {158}),
        ({"progress_min": 0, "progress_max": 10**50}, {0, 100, 101, 158, 200}),
    ]
    for bounds, expected in cases:
        response = await alice.post(
            "/api/training/sessions", json={"mode": "input", "size": "all", **bounds}
        )
        assert response.status_code == 201, response.text
        assert {item["prompt"] for item in response.json()["items"]} == {
            f"word{value}" for value in expected
        }
    response = await alice.post(
        "/api/training/sessions", json={"mode": "input", "progress_min": 10**50}
    )
    assert response.status_code == 409 and response.json()["detail"] == "no_matching_words"


async def test_failed_filtered_starts_leave_no_partial_sessions(
    app: FastAPI, alice: Client
) -> None:
    word = await add_word(alice, "word", "слово", tags=["selected"], example_en="No match")
    tag = word["tags"][0]["id"]
    cases = [
        ({"mode": "choice", "tag_ids": [tag]}, 409, "not_enough_words"),
        (
            {"mode": "cloze", "direction": "en_en", "tag_ids": [tag]},
            409,
            "no_eligible_cloze_examples",
        ),
        ({"mode": "input", "tag_ids": ["unknown"]}, 404, "tag_not_found"),
        ({"mode": "input", "progress_min": 2, "progress_max": 1}, 422, None),
    ]
    for body, status, detail in cases:
        response = await alice.post("/api/training/sessions", json=body)
        assert response.status_code == status
        if detail is not None:
            assert response.json()["detail"] == detail
        database: Database = app.state.db
        async with database.sessions() as db:
            assert (await db.scalars(select(TrainingSession))).all() == []
            assert (await db.scalars(select(TrainingItem))).all() == []
