import pytest
from fastapi import FastAPI
from sqlalchemy import select

from lexicona.infrastructure.db import Database
from lexicona.infrastructure.models import AnswerEvent, Word
from tests.conftest import Client, add_legacy_cloze_item, add_word
from tests.test_training_input import start_input
from tests.test_words import set_progress


@pytest.mark.parametrize(
    ("canonical", "variant"),
    [
        ("you're all set", "youre all set"),
        ("you’re all set", "YOU'RE ALL SET."),
        ("low-life", "low life"),
        ("low life", "low‑life"),
        ("low‐life", "low-life"),
    ],
)
async def test_first_variant_gets_full_reward_once(
    app: FastAPI, alice: Client, canonical: str, variant: str
) -> None:
    await add_word(alice, canonical, "перевод")
    item = await start_input(alice, "ru_en")
    url = f"/api/training/items/{item['id']}/answer"
    response = await alice.post(url, json={"text": variant})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    result = response.json()
    assert result["correct"] is True
    assert result["delta"] == result["progress"] == 8
    assert result["expected_answers"] == [canonical]
    assert result["submitted_text"] == variant
    assert (await alice.post(url, json={"text": canonical})).json() == result
    assert (await alice.post(url, json={"text": "wrong"})).json() == result
    database: Database = app.state.db
    async with database.sessions() as db:
        events = list(await db.scalars(select(AnswerEvent)))
        assert len(events) == 1 and events[0].correct and events[0].delta == 8


@pytest.mark.parametrize(
    ("canonical", "wrong", "variant"),
    [("can't", "can", "cant"), ("low-life", "lowlife", "low life")],
)
async def test_variant_after_error_does_not_reverse_first_penalty(
    app: FastAPI, alice: Client, canonical: str, wrong: str, variant: str
) -> None:
    word = await add_word(alice, canonical, "перевод")
    await set_progress(app, word["id"], 20)
    item = await start_input(alice, "ru_en")
    url = f"/api/training/items/{item['id']}/answer"
    error = (await alice.post(url, json={"text": wrong})).json()
    assert error["correct"] is False and error["delta"] == -4 and error["progress"] == 16
    correction = (await alice.post(url, json={"text": variant})).json()
    assert correction["correct"] is True and correction["delta"] == 0
    assert correction["progress"] == 16
    assert (await alice.post(url, json={"text": canonical})).json() == correction
    database: Database = app.state.db
    async with database.sessions() as db:
        events = list(await db.scalars(select(AnswerEvent)))
        assert len(events) == 1 and not events[0].correct and events[0].delta == -4


@pytest.mark.parametrize(
    ("canonical", "variant", "prefix", "hint"),
    [
        ("you're all set", "youre all set", "youre all s", "you're all se"),
        ("low-life", "low life", "low l", "low-li"),
    ],
)
async def test_hint_uses_answer_policy_and_canonical_prefix(
    alice: Client, canonical: str, variant: str, prefix: str, hint: str
) -> None:
    await add_word(alice, canonical, "перевод")
    clean = await start_input(alice, "ru_en")
    url = f"/api/training/items/{clean['id']}"
    assert (await alice.post(f"{url}/hint", json={"text": variant})).json() == {
        "text": variant,
        "complete": True,
    }
    assert (await alice.post(f"{url}/answer", json={"text": variant})).json()["delta"] == 8
    hinted = await start_input(alice, "ru_en")
    url = f"/api/training/items/{hinted['id']}"
    assert (await alice.post(f"{url}/hint", json={"text": prefix})).json() == {
        "text": hint,
        "complete": False,
    }
    result = (await alice.post(f"{url}/answer", json={"text": variant})).json()
    assert result["correct"] is True and result["delta"] == 4
    assert (await alice.post(f"{url}/answer", json={"text": canonical})).json() == result


async def test_legacy_cloze_accepts_answer_variant(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "low-life", "перевод", example_en="He is a low-life.")
    item = await add_legacy_cloze_item(app, alice, word["id"])
    assert (
        await alice.post(f"/api/training/items/{item['id']}/hint", json={"text": "low life"})
    ).json() == {"text": "low life", "complete": True}
    result = (
        await alice.post(f"/api/training/items/{item['id']}/answer", json={"text": "low life"})
    ).json()
    assert result["correct"] is True and result["delta"] == 8
    assert result["expected_answers"] == ["low-life"]


@pytest.mark.parametrize(
    ("before", "after"), [("other-word", "other word"), ("we're ready", "were ready")]
)
async def test_uniqueness_and_semantic_edits_remain_conservative(
    app: FastAPI, alice: Client, before: str, after: str
) -> None:
    for canonical, variant in [("you're all set", "youre all set"), ("low-life", "low life")]:
        first = await add_word(alice, canonical, "перевод")
        second = await add_word(alice, variant, "перевод")
        assert first["id"] != second["id"]
    word = await add_word(alice, before, "перевод")
    await set_progress(app, word["id"], 20)
    result = await alice.put(
        f"/api/words/{word['id']}", json={"headword": after, "translations": ["перевод"]}
    )
    assert result.status_code == 200
    assert result.json()["progress"] == 0
    database: Database = app.state.db
    async with database.sessions() as db:
        saved = await db.get(Word, word["id"])
        assert saved is not None and saved.content_version == 2
