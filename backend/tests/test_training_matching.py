import asyncio
from typing import Any

from fastapi import FastAPI
from sqlalchemy import select

from lexicona.db import Database
from lexicona.models import TrainingItem, WordProgress
from lexicona.normalize import normalize
from tests.conftest import Client, add_word
from tests.test_words import set_progress

PAIRS = [("cat", "кот"), ("dog", "собака"), ("fox", "лиса"), ("owl", "сова")]


async def start(client: Client, **body: Any) -> Any:
    response = await client.post(
        "/api/training/sessions", json={"mode": "matching", "direction": "en_ru", **body}
    )
    assert response.status_code == 201, response.text
    return response.json()


async def correct_option(app: FastAPI, item_id: str) -> int:
    database: Database = app.state.db
    async with database.sessions() as db:
        item = await db.get(TrainingItem, item_id)
        assert item is not None and item.correct_option is not None
        return item.correct_option


async def seed(client: Client) -> dict[str, Any]:
    return {en: await add_word(client, en, ru) for en, ru in PAIRS}


async def test_matching_batches_are_unambiguous_and_hide_answers(
    app: FastAPI, alice: Client
) -> None:
    await seed(alice)
    await add_word(alice, "wolf", "волк")
    await add_word(alice, "cow", "корова")
    await add_word(alice, "bear", "медведь")
    await add_word(alice, "goat", "коза")
    await add_word(alice, "horse", "лошадь")
    await add_word(alice, "pig", "свинья")
    session = await start(alice, size="all")
    assert session["mode"] == "matching" and session["direction"] == "en_ru"
    assert len(session["items"]) == 10
    translations = dict(PAIRS) | {
        "wolf": "волк",
        "cow": "корова",
        "bear": "медведь",
        "goat": "коза",
        "horse": "лошадь",
        "pig": "свинья",
    }
    assert [len(session["items"][offset : offset + 8]) for offset in (0, 8)] == [8, 2]
    for offset in range(0, len(session["items"]), 8):
        batch = session["items"][offset : offset + 8]
        assert 1 <= len(batch) <= 8
        options = batch[0]["options"]
        assert len(options) == len(batch)
        assert len({normalize(option) for option in options}) == len(options)
        assert {item["prompt"] for item in batch} <= set(translations)
        assert set(options) == {translations[item["prompt"]] for item in batch}
        for item in batch:
            assert set(item) == {"id", "prompt", "options"}
            assert item["options"] == options
            assert "correct_option" not in item
            assert await correct_option(app, item["id"]) == options.index(
                translations[item["prompt"]]
            )


async def test_matching_rejects_other_directions_and_text_answers(alice: Client) -> None:
    await seed(alice)
    for direction in ["ru_en", "en_en"]:
        response = await alice.post(
            "/api/training/sessions", json={"mode": "matching", "direction": direction}
        )
        assert response.status_code == 422
    item = (await start(alice))["items"][0]
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"text": "кот"})
    assert response.status_code == 422


async def test_matching_skips_ambiguous_pairs_within_a_batch(alice: Client) -> None:
    await seed(alice)
    await add_word(alice, "kitty", "котёнок", "кот")
    session = await start(alice, size="all")
    assert len(session["items"]) == 4
    for offset in range(0, len(session["items"]), 8):
        prompts = {item["prompt"] for item in session["items"][offset : offset + 8]}
        assert not {"cat", "kitty"} <= prompts


async def test_matching_concurrent_answers_apply_once(app: FastAPI, alice: Client) -> None:
    await seed(alice)
    item = (await start(alice, purpose="scheduled"))["items"][0]
    right = await correct_option(app, item["id"])
    url = f"/api/training/items/{item['id']}/answer"
    responses = await asyncio.gather(*[alice.post(url, json={"option": right}) for _ in range(5)])
    assert all(response.status_code == 200 for response in responses)
    assert {response.json()["progress"] for response in responses} == {4}
    database: Database = app.state.db
    async with database.sessions() as db:
        saved = await db.get(TrainingItem, item["id"])
        assert saved is not None
        progress = await db.scalar(
            select(WordProgress).where(WordProgress.word_id == saved.word_id)
        )
        assert progress is not None and progress.review_count == 1


async def test_matching_filters_and_excluded_words(app: FastAPI, alice: Client) -> None:
    cat = await add_word(alice, "cat", "кот", tags=["animals", "selected"])
    await add_word(alice, "dog", "собака", tags=["animals"])
    owl = await add_word(alice, "owl", "сова", tags=["animals", "selected"])
    await set_progress(app, cat["id"], 10)
    await set_progress(app, owl["id"], 10)
    await alice.patch(f"/api/words/{owl['id']}/training", json={"is_excluded": True})
    session = await start(
        alice,
        size="all",
        tag_ids=[tag["id"] for tag in cat["tags"]],
        progress_min=10,
        progress_max=10,
    )
    assert [item["prompt"] for item in session["items"]] == ["cat"]


async def test_matching_first_error_and_retries_have_one_effect(
    app: FastAPI, alice: Client
) -> None:
    words = await seed(alice)
    await set_progress(app, words["cat"]["id"], 50)
    session = await start(alice, size=4)
    item = next(item for item in session["items"] if item["prompt"] == "cat")
    right = await correct_option(app, item["id"])
    wrong = (right + 1) % len(item["options"])
    url = f"/api/training/items/{item['id']}/answer"

    first = (await alice.post(url, json={"option": wrong})).json()
    assert first["correct"] is False and first["delta"] == -4 and first["progress"] == 46
    retry = (await alice.post(url, json={"option": (wrong + 1) % len(item["options"])})).json()
    assert retry["delta"] == 0 and retry["progress"] == 46
    final = (await alice.post(url, json={"option": right})).json()
    assert final["correct"] is True and final["delta"] == 0 and final["progress"] == 46
    assert (await alice.post(url, json={"option": wrong})).json() == final

    for other in session["items"]:
        if other["id"] == item["id"]:
            continue
        other_right = await correct_option(app, other["id"])
        result = await alice.post(
            f"/api/training/items/{other['id']}/answer", json={"option": other_right}
        )
        assert result.json()["delta"] == 4
    saved = await alice.get(f"/api/words/{words['cat']['id']}")
    assert saved.json()["progress"] == 46


async def test_matching_scheduled_retry_does_not_review_twice(app: FastAPI, alice: Client) -> None:
    words = await seed(alice)
    session = await start(alice, purpose="scheduled", size=2)
    item = session["items"][0]
    right = await correct_option(app, item["id"])
    wrong = (right + 1) % len(item["options"])
    url = f"/api/training/items/{item['id']}/answer"
    assert (await alice.post(url, json={"option": wrong})).json()["correct"] is False
    assert (await alice.post(url, json={"option": right})).json()["correct"] is True
    word_id = next(word["id"] for word in words.values() if word["headword"] == item["prompt"])
    database: Database = app.state.db
    async with database.sessions() as db:
        rows = (await db.scalars(select(WordProgress).where(WordProgress.word_id == word_id))).all()
        assert len(rows) == 1
        assert rows[0].review_count == 1
        assert rows[0].lapse_count == 1
        assert rows[0].has_review is True


async def test_matching_content_edit_and_exclusion_invalidate_progress(
    app: FastAPI, alice: Client
) -> None:
    words = await seed(alice)
    item = next(item for item in (await start(alice))["items"] if item["prompt"] == "cat")
    right = await correct_option(app, item["id"])
    await alice.put(
        f"/api/words/{words['cat']['id']}",
        json={"headword": "cat", "translations": ["кошка"]},
    )
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"option": right})
    assert response.json()["delta"] == 0 and response.json()["progress"] == 0

    item = next(item for item in (await start(alice))["items"] if item["prompt"] == "dog")
    await alice.patch(f"/api/words/{words['dog']['id']}/training", json={"is_excluded": True})
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"option": 0})
    assert response.json() == {
        "outcome": "unavailable",
        "reason": "training_state_changed",
        "delta": 0,
        "progress": 0,
    }


async def test_matching_reveal_skip_owner_csrf_and_no_store(alice: Client, bob: Client) -> None:
    await seed(alice)
    response = await bob.post(
        "/api/training/sessions", json={"mode": "matching", "direction": "en_ru"}
    )
    assert response.status_code == 409 and response.headers["cache-control"] == "no-store"
    session = await start(alice, size=2)
    revealed, skipped = session["items"]
    url = f"/api/training/items/{revealed['id']}"
    assert (await bob.post(f"{url}/reveal")).status_code == 404
    assert (await bob.post(f"{url}/skip")).status_code == 404
    assert (await bob.post(f"{url}/answer", json={"option": 0})).status_code == 404
    del alice.headers["X-CSRF-Token"]
    assert (
        await alice.post("/api/training/sessions", json={"mode": "matching"})
    ).status_code == 403
    assert (await alice.post(f"{url}/answer", json={"option": 0})).status_code == 403
    assert (await alice.post(f"{url}/reveal")).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    response = await alice.post(f"{url}/reveal")
    assert response.headers["cache-control"] == "no-store"
    result = response.json()
    assert result["outcome"] == "assisted" and result["delta"] == 0
    assert result["expected_answers"] == [revealed["options"][result["correct_option"]]]
    assert (await alice.post(f"{url}/skip")).json() == result

    response = await alice.post(f"/api/training/items/{skipped['id']}/skip")
    assert response.json()["outcome"] == "skipped" and response.json()["delta"] == 0
