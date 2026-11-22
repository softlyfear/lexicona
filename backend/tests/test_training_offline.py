import asyncio
from datetime import UTC, datetime

from fastapi import FastAPI
from sqlalchemy import func, select, update

from lexicona.infrastructure.db import Database
from lexicona.infrastructure.models import AnswerEvent, TrainingSession, User
from tests.conftest import Client, add_word
from tests.test_auth import TRAINING
from tests.test_words import set_progress

PACK = "/api/training/offline-pack"
KEY = {"key": "a" * 32}


async def test_offline_pack_is_bounded_isolated_and_kept_out_of_online_resume(
    app: FastAPI, anon: Client, alice: Client, bob: Client
) -> None:
    await add_word(bob, "elephant", "слон")
    assert (await anon.post(PACK, json=KEY)).status_code == 401
    assert (await alice.post(PACK, json=KEY)).json() is None
    await add_word(alice, "cat", "кот")
    online = await alice.post("/api/training/sessions", json={"mode": "input"})
    for i in range(21):
        await add_word(alice, f"term {i}", f"перевод {i}")
    excluded = await add_word(alice, "dog", "собака")
    await alice.patch(f"/api/words/{excluded['id']}/training", json={"is_excluded": True})

    del alice.headers["X-CSRF-Token"]
    assert (await alice.post(PACK, json=KEY)).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    assert (await alice.post(PACK, json={"key": "invalid"})).status_code == 422

    responses = await asyncio.gather(*[alice.post(PACK, json=KEY) for _ in range(3)])
    pack = responses[0].json()
    assert all(response.status_code == 200 and response.json() == pack for response in responses)
    assert all(response.headers["cache-control"] == "no-store" for response in responses)
    assert pack["owner_id"] == (await alice.get("/api/auth/me")).json()["user"]["id"]
    assert datetime.fromisoformat(pack["expires_at"]).tzinfo == UTC
    assert pack["requested_size"] == 10
    assert len(pack["items"]) == len(pack["study"]) == 10
    assert all(set(item) == {"id", "prompt"} for item in pack["items"])
    practice_words = {item["prompt"] for item in pack["items"]}
    study_words = {word["headword"] for word in pack["study"]}
    assert not practice_words & study_words
    assert not {"dog", "elephant"} & (practice_words | study_words)
    assert (await alice.get("/api/training/sessions/latest")).json()["id"] == online.json()["id"]

    other = (await bob.post(PACK, json=KEY)).json()
    assert other["id"] != pack["id"]
    assert other["owner_id"] != pack["owner_id"]
    assert [item["prompt"] for item in other["items"]] == ["elephant"]
    assert other["study"] == []
    item_url = f"/api/training/items/{pack['items'][0]['id']}"
    assert (await bob.post(f"{item_url}/answer", json={"text": "кот"})).status_code == 404
    assert (await alice.post(f"{item_url}/hint", json={"text": ""})).status_code == 422
    assert (await alice.post(f"{item_url}/reveal")).status_code == 422

    database: Database = app.state.db
    async with database.sessions() as db:
        assert (
            await db.scalar(
                select(func.count()).select_from(TrainingSession).where(TrainingSession.is_offline)
            )
            == 2
        )


async def test_offline_pack_size_uses_saved_preferences_and_freezes_on_replay(
    alice: Client,
) -> None:
    words = {f"term {i}" for i in range(15)}
    for word in sorted(words):
        await add_word(alice, word, f"перевод {word}")
    excluded = await add_word(alice, "fox", "лиса")
    learned = await add_word(alice, "dog", "собака")
    assert (
        await alice.patch(f"/api/words/{excluded['id']}/training", json={"is_excluded": True})
    ).status_code == 200
    assert (
        await alice.patch(f"/api/words/{learned['id']}/learned", json={"is_learned": True})
    ).status_code == 200

    normal = (await alice.post(PACK, json=KEY)).json()
    assert normal["requested_size"] == 10
    settings = "/api/auth/settings"
    training = {**TRAINING, "size": 12, "include_learned": True}
    assert (await alice.put(settings, json={"training": training})).status_code == 200
    numeric_key = {"key": "b" * 32}
    numeric = (await alice.post(PACK, json=numeric_key)).json()
    assert numeric["requested_size"] == 12
    assert len(numeric["items"]) == 12
    assert len(numeric["study"]) == 3
    exercises = {item["prompt"] for item in numeric["items"]}
    study = {word["headword"] for word in numeric["study"]}
    assert not exercises & study and exercises | study == words

    assert (
        await alice.put(settings, json={"training": {**training, "size": "all"}})
    ).status_code == 200
    all_words = (await alice.post(PACK, json={"key": "c" * 32})).json()
    assert all_words["requested_size"] == "all"
    assert {item["prompt"] for item in all_words["items"]} == words
    assert all_words["study"] == []
    assert (await alice.post(PACK, json=numeric_key)).json() == numeric
    assert (await alice.post(PACK, json=KEY)).json() == normal


async def test_offline_pack_uses_validated_legacy_preferences(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот")
    owner_id = (await alice.get("/api/auth/me")).json()["user"]["id"]
    database: Database = app.state.db
    async with database.sessions() as db:
        await db.execute(
            update(User).where(User.id == owner_id).values(preferences={"training": TRAINING})
        )
        await db.commit()
    legacy = (await alice.post(PACK, json=KEY)).json()
    assert legacy["requested_size"] == 25
    assert [item["prompt"] for item in legacy["items"]] == [word["headword"]]
    assert legacy["study"] == []

    async with database.sessions() as db:
        await db.execute(
            update(User)
            .where(User.id == owner_id)
            .values(preferences={"training": {**TRAINING, "size": "25"}})
        )
        await db.commit()
    invalid = (await alice.post(PACK, json={"key": "b" * 32})).json()
    assert invalid["requested_size"] == 10


async def test_offline_wrong_answer_is_terminal_and_replayed_once(
    app: FastAPI, alice: Client
) -> None:
    cat = await add_word(alice, "cat", "кот")
    dog = await add_word(alice, "dog", "собака")
    await set_progress(app, cat["id"], 20)
    await set_progress(app, dog["id"], 30)
    pack = (await alice.post(PACK, json=KEY)).json()
    assert (await alice.get("/api/training/sessions/latest")).json() is None
    item = pack["items"][0]
    assert item["prompt"] == "cat"
    url = f"/api/training/items/{item['id']}/answer"
    outcomes = await asyncio.gather(*[alice.post(url, json={"text": "ошибка"}) for _ in range(3)])
    expected = {
        "outcome": "answered",
        "correct": False,
        "submitted_text": "ошибка",
        "expected_answers": ["кот"],
        "delta": -4,
        "progress": 16,
    }
    assert all(response.status_code == 200 and response.json() == expected for response in outcomes)
    assert (await alice.post(url, json={"text": "кот"})).json() == expected
    finish = await alice.post(f"/api/training/sessions/{pack['id']}/finish")
    assert finish.json()["status"] == "finished"
    assert (await alice.post(url, json={"text": "ошибка"})).json() == expected
    assert (await alice.get(f"/api/words/{cat['id']}")).json()["progress"] == 16

    database: Database = app.state.db
    async with database.sessions() as db:
        assert (
            await db.scalar(
                select(func.count())
                .select_from(AnswerEvent)
                .where(AnswerEvent.item_id == item["id"])
            )
            == 1
        )


async def test_offline_content_and_concurrent_progress_are_checked_on_sync(alice: Client) -> None:
    cat = await add_word(alice, "cat", "кот")
    await add_word(alice, "dog", "собака")
    await add_word(alice, "bird", "птица")
    await add_word(alice, "fish", "рыба")
    pack = (await alice.post(PACK, json=KEY)).json()
    cat_item, dog_item = pack["items"][:2]
    assert [cat_item["prompt"], dog_item["prompt"]] == ["cat", "dog"]

    updated = await alice.put(
        f"/api/words/{cat['id']}", json={"headword": "cat", "translations": ["кошка"]}
    )
    assert updated.status_code == 200
    cat_result = await alice.post(
        f"/api/training/items/{cat_item['id']}/answer", json={"text": "кот"}
    )
    assert cat_result.json() == {
        "outcome": "unavailable",
        "reason": "training_state_changed",
        "delta": 0,
        "progress": 0,
    }

    online = await alice.post("/api/training/sessions", json={"mode": "input"})
    online_dog = next(item["id"] for item in online.json()["items"] if item["prompt"] == "dog")
    credited = await alice.post(f"/api/training/items/{online_dog}/answer", json={"text": "собака"})
    assert credited.json()["progress"] == 8
    dog_result = await alice.post(
        f"/api/training/items/{dog_item['id']}/answer", json={"text": "собака"}
    )
    assert dog_result.status_code == 409 and dog_result.json()["detail"] == "PROGRESS_CHANGED"
