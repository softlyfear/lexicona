import asyncio
from typing import Any

from fastapi import FastAPI
from sqlalchemy import select

from lexicona.db import Database
from lexicona.models import TrainingItem
from lexicona.normalize import normalize
from tests.conftest import Client, add_word
from tests.test_words import set_progress

ANIMALS = [("cat", "кот"), ("dog", "собака"), ("cow", "корова"), ("fox", "лиса"), ("owl", "сова")]


async def seed(client: Client) -> dict[str, Any]:
    return {en: await add_word(client, en, ru) for en, ru in ANIMALS}


async def start(client: Client, **body: Any) -> Any:
    response = await client.post("/api/training/sessions", json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def correct_option(app: FastAPI, item_id: str) -> int:
    database: Database = app.state.db
    async with database.sessions() as db:
        item = await db.get(TrainingItem, item_id)
        assert item is not None
        return item.correct_option


async def test_needs_at_least_four_distinct_words(alice: Client) -> None:
    for en, ru in ANIMALS[:3]:
        await add_word(alice, en, ru)
    response = await alice.post("/api/training/sessions", json={})
    assert response.status_code == 409
    assert response.json()["detail"] == "not_enough_words"


async def test_session_has_four_unique_options_and_hides_answer(alice: Client) -> None:
    await seed(alice)
    session = await start(alice, size=5)
    assert len(session["items"]) == 5
    translations = dict(ANIMALS)
    for item in session["items"]:
        assert set(item) == {"id", "prompt", "options"}
        assert len(item["options"]) == 4
        assert len({normalize(o) for o in item["options"]}) == 4
        assert translations[item["prompt"]] in item["options"]


async def test_ru_en_direction(alice: Client) -> None:
    await seed(alice)
    session = await start(alice, direction="ru_en")
    english = {en for en, _ in ANIMALS}
    for item in session["items"]:
        assert item["prompt"] not in english
        assert set(item["options"]) <= english


async def test_distractors_never_share_a_meaning_with_the_target(alice: Client) -> None:
    await seed(alice)
    # "kitty" also means "кот": it must never appear as a wrong option for "cat".
    await add_word(alice, "kitty", "котёнок", "кот")
    for _ in range(10):
        session = await start(alice, size=10)
        for item in session["items"]:
            if item["prompt"] == "cat":
                assert "котёнок" not in item["options"]
            if item["prompt"] == "kitty":
                assert "кот" not in item["options"]


async def test_least_known_words_come_first(app: FastAPI, alice: Client) -> None:
    words = await seed(alice)
    for en, value in [("cat", 90), ("dog", 80), ("cow", 70), ("fox", 0), ("owl", 10)]:
        await set_progress(app, words[en]["id"], value)
    session = await start(alice, size=2)
    assert [item["prompt"] for item in session["items"]] == ["fox", "owl"]


async def test_correct_and_wrong_answers_move_progress(app: FastAPI, alice: Client) -> None:
    words = await seed(alice)
    await set_progress(app, words["cat"]["id"], 50)
    session = await start(alice)
    item = next(i for i in session["items"] if i["prompt"] == "cat")
    right = await correct_option(app, item["id"])

    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"option": right})
    assert response.json() == {
        "correct": True,
        "correct_option": right,
        "chosen_option": right,
        "delta": 4,
        "progress": 54,
    }

    other = next(i for i in session["items"] if i["prompt"] == "dog")
    wrong = (await correct_option(app, other["id"]) + 1) % 4
    response = await alice.post(f"/api/training/items/{other['id']}/answer", json={"option": wrong})
    body = response.json()
    assert body["correct"] is False
    assert body["delta"] == -4
    assert body["progress"] == 0  # clamped


async def test_repeated_answer_counts_once(app: FastAPI, alice: Client) -> None:
    await seed(alice)
    item = (await start(alice))["items"][0]
    right = await correct_option(app, item["id"])
    url = f"/api/training/items/{item['id']}/answer"
    first = (await alice.post(url, json={"option": right})).json()
    again = (await alice.post(url, json={"option": (right + 1) % 4})).json()
    assert first == again
    assert first["progress"] == 4


async def test_concurrent_answers_count_once(app: FastAPI, alice: Client) -> None:
    await seed(alice)
    item = (await start(alice))["items"][0]
    right = await correct_option(app, item["id"])
    url = f"/api/training/items/{item['id']}/answer"
    results = await asyncio.gather(*[alice.post(url, json={"option": right}) for _ in range(5)])
    assert {r.json()["progress"] for r in results} == {4}


async def test_difficulty_is_frozen_per_session(app: FastAPI, alice: Client) -> None:
    await alice.put("/api/auth/settings", json={"difficulty": "very_easy"})
    await seed(alice)
    item = (await start(alice))["items"][0]
    await alice.put("/api/auth/settings", json={"difficulty": "very_hard"})
    right = await correct_option(app, item["id"])
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"option": right})
    assert response.json()["delta"] == 10


async def test_answer_after_meaning_edit_does_not_count(app: FastAPI, alice: Client) -> None:
    words = await seed(alice)
    session = await start(alice)
    item = next(i for i in session["items"] if i["prompt"] == "cat")
    await alice.put(
        f"/api/words/{words['cat']['id']}", json={"headword": "cat", "translations": ["кошка"]}
    )
    right = await correct_option(app, item["id"])
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"option": right})
    assert response.json()["delta"] == 0
    assert response.json()["progress"] == 0


async def test_items_of_deleted_words_disappear(app: FastAPI, alice: Client) -> None:
    words = await seed(alice)
    item = (await start(alice))["items"][0]
    word_id = next(w["id"] for en, w in words.items() if en == item["prompt"])
    await alice.delete(f"/api/words/{word_id}")
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"option": 0})
    assert response.status_code == 404
    database: Database = app.state.db
    async with database.sessions() as db:
        assert await db.scalar(select(TrainingItem).where(TrainingItem.id == item["id"])) is None


async def test_cannot_answer_someone_elses_item(alice: Client, bob: Client) -> None:
    await seed(alice)
    item = (await start(alice))["items"][0]
    response = await bob.post(f"/api/training/items/{item['id']}/answer", json={"option": 0})
    assert response.status_code == 404


async def test_option_out_of_range(alice: Client) -> None:
    await seed(alice)
    item = (await start(alice))["items"][0]
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"option": 4})
    assert response.status_code == 422
