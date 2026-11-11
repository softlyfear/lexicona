import pytest
from fastapi import FastAPI
from sqlalchemy import func, select

from lexicona.infrastructure.db import Database
from lexicona.infrastructure.models import TrainingItem, TrainingSession, WordProgress
from tests.conftest import Client, add_word


@pytest.mark.parametrize(
    "mode,direction",
    [("choice", "en_ru"), ("choice", "ru_en"), ("input", "ru_en"), ("matching", "en_ru")],
)
@pytest.mark.parametrize("shuffle", [False, True])
async def test_preview_matches_start(
    alice: Client, mode: str, direction: str, shuffle: bool
) -> None:
    for i in range(12):
        await add_word(alice, f"word{i}", f"перевод{i % 4}")
    body = {
        "mode": mode,
        "direction": direction,
        "size": "all",
        "order": "random",
        "shuffle": shuffle,
    }
    for _ in range(5):
        preview = await alice.post("/api/training/sessions/preview", json=body)
        assert preview.status_code == 200
        result = preview.json()
        assert set(result) == {"count", "selection_seed", "unavailable_reason"}
        assert result["unavailable_reason"] is None
        started = await alice.post(
            "/api/training/sessions", json={**body, "selection_seed": result["selection_seed"]}
        )
        assert started.status_code == 201, started.text
        assert len(started.json()["items"]) == result["count"]


async def test_preview_is_read_only_and_isolated(app: FastAPI, alice: Client, bob: Client) -> None:
    word = await add_word(alice, "cat", "кот", tags=["pets"])
    database: Database = app.state.db
    async with database.sessions() as db:
        # Simulate legacy or direct ORM words without schedules.
        schedule = await db.scalar(select(WordProgress).where(WordProgress.word_id == word["id"]))
        assert schedule is not None
        await db.delete(schedule)
        await db.commit()
    body = {"mode": "input", "purpose": "scheduled", "tag_ids": [word["tags"][0]["id"]]}
    assert (await bob.post("/api/training/sessions/preview", json=body)).status_code == 404
    result = await alice.post("/api/training/sessions/preview", json=body)
    assert result.status_code == 200 and result.headers["cache-control"] == "no-store"
    assert result.json()["count"] == 1
    async with database.sessions() as db:
        for model in (TrainingSession, TrainingItem, WordProgress):
            assert await db.scalar(select(func.count()).select_from(model)) == 0
    del alice.headers["X-CSRF-Token"]
    assert (await alice.post("/api/training/sessions/preview", json=body)).status_code == 403


async def test_preview_empty_validation_and_changed_pool(alice: Client) -> None:
    url = "/api/training/sessions/preview"
    assert (await alice.post(url, json={"purpose": "scheduled"})).json()[
        "unavailable_reason"
    ] == "no_scheduled_words"
    assert (await alice.post(url, json={})).json()["unavailable_reason"] == "not_enough_words"
    assert (await alice.post(url, json={"progress_min": 1})).json()[
        "unavailable_reason"
    ] == "no_matching_words"
    assert (await alice.post(url, json={"selection_seed": "bad"})).status_code == 422
    preview = (await alice.post(url, json={"mode": "input"})).json()
    await add_word(alice, "cat", "кот")
    started = await alice.post(
        "/api/training/sessions",
        json={"mode": "input", "selection_seed": preview["selection_seed"]},
    )
    assert preview["count"] == 0 and len(started.json()["items"]) == 1


async def test_matching_seed_stabilizes_variable_count(alice: Client) -> None:
    await add_word(alice, "central", *[f"значение{i}" for i in range(8)])
    for i in range(8):
        await add_word(alice, f"leaf{i}", f"значение{i}")
    counts = set()
    for seed in range(25):
        body = {"mode": "matching", "size": "all", "selection_seed": f"{seed:032x}"}
        preview = (await alice.post("/api/training/sessions/preview", json=body)).json()
        started = await alice.post("/api/training/sessions", json=body)
        assert started.status_code == 201
        assert preview["count"] == len(started.json()["items"])
        counts.add(preview["count"])
    assert len(counts) > 1


async def test_preview_scheduled_filters_and_new_limit(alice: Client) -> None:
    words = [await add_word(alice, f"word{i}", f"перевод{i}", tags=["chosen"]) for i in range(13)]
    await add_word(alice, "other", "другое")
    body = {
        "mode": "input",
        "purpose": "scheduled",
        "include_new": True,
        "size": "all",
        "tag_ids": [words[0]["tags"][0]["id"]],
        "progress_min": 0,
        "progress_max": 0,
        "order": "created_asc",
        "shuffle": True,
    }
    preview = (await alice.post("/api/training/sessions/preview", json=body)).json()
    started = await alice.post(
        "/api/training/sessions", json={**body, "selection_seed": preview["selection_seed"]}
    )
    assert preview["count"] == 10 == len(started.json()["items"])
    empty = (
        await alice.post("/api/training/sessions/preview", json={**body, "include_new": False})
    ).json()
    assert empty["count"] == 0 and empty["unavailable_reason"] == "no_scheduled_words"


async def test_matching_preview_shuffle_keeps_ordered_prefix_at_batch_boundary(
    alice: Client,
) -> None:
    for i in range(8):
        await add_word(alice, f"word{i}", f"значение{i}")
    # The ninth word conflicts with every word in the first batch; the tenth
    # could be used only if selection improperly looked beyond the prefix.
    await add_word(alice, "conflict", *[f"значение{i}" for i in range(8)])
    await add_word(alice, "outside", "другое")
    body = {
        "mode": "matching",
        "size": 9,
        "order": "created_asc",
        "shuffle": True,
        "selection_seed": "00000000000000000000000000000000",
    }
    preview = (await alice.post("/api/training/sessions/preview", json=body)).json()
    started = await alice.post("/api/training/sessions", json=body)
    assert started.status_code == 201
    items = started.json()["items"]
    assert preview["count"] == len(items)
    assert all(item["prompt"] != "outside" for item in items)
    assert len(items) < 9
    assert len(items[0]["options"]) == len(items)
