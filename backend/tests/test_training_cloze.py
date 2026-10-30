import asyncio
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from fastapi import FastAPI

from lexicona.cloze import mask_example
from tests.conftest import Client, add_word
from tests.test_app import alembic_config
from tests.test_words import set_progress


@pytest.mark.parametrize(
    ("headword", "example", "expected"),
    [
        ("cat", "A (Cat) sleeps.", "A (____) sleeps."),
        ("look up", "Please LOOK \t UP now.", "Please ____ now."),
        ("can't", "I CAN’T swim.", "I ____ swim."),
        ("café", "A cafe\u0301 is here.", "A ____ is here."),
        ("ice-cream", "I eat ice-cream.", "I eat ____."),
        ("cat", "category cats cat-like", None),
        ("can", "I can't.", None),
        ("cat", "_cat cat_ cat2 2cat", None),
        ("cat", "cat / Cat", None),
        ("a a", "a a a", None),
        ("look up", "look, up", None),
        ("cat", "", None),
        ("cat", None, None),
        ("cat", "No match.", None),
        ("ss", "ß", "____"),
        ("s", "ß", None),
        ("s", "ß s", "ß ____"),
        ("cat", "scatter cat.", "scatter ____."),
        ("cat", "cat\u0301", None),
        ("cat", "cat’", None),
        ("cat", "猫cat", None),
        ("go go", "Go\n GO!", "____!"),
        ("cat", "The cat" + "!" * 1800, "The ____" + "!" * 1800),
    ],
)
def test_mask_example(headword: str, example: str | None, expected: str | None) -> None:
    assert mask_example(headword, example) == expected


@pytest.mark.parametrize("hyphen", ["‐", "‑"])
@pytest.mark.parametrize("compound_first", [True, False])
def test_hyphenated_word_is_not_a_complete_match(hyphen: str, compound_first: bool) -> None:
    compound = f"cat{hyphen}like" if compound_first else f"like{hyphen}cat"
    assert mask_example("cat", f"A {compound} shape.") is None
    assert mask_example("cat", f"A {compound} shape and a cat.") == (
        f"A {compound} shape and a ____."
    )


@pytest.mark.parametrize("hyphen", ["‐", "‑"])
async def test_cloze_session_requires_separate_word_with_unicode_hyphen(
    alice: Client, hyphen: str
) -> None:
    word = await add_word(alice, "cat", "кот", example_en=f"A cat{hyphen}like shape.")
    response = await start(alice)
    assert response.status_code == 409
    assert response.json() == {"detail": "no_eligible_cloze_examples"}
    response = await alice.put(
        f"/api/words/{word['id']}",
        json={
            "headword": "cat",
            "translations": ["кот"],
            "example_en": f"A cat{hyphen}like shape and a cat.",
        },
    )
    assert response.status_code == 200
    response = await start(alice)
    assert response.status_code == 201
    assert response.json()["items"][0]["prompt"] == f"A cat{hyphen}like shape and a ____."


async def start(client: Client, size: int = 10) -> Any:
    return await client.post(
        "/api/training/sessions", json={"mode": "cloze", "direction": "en_en", "size": size}
    )


async def test_session_filters_pool_and_hides_answer(alice: Client, bob: Client) -> None:
    await add_word(alice, "dog", "пёс", example_en="dogs bark")
    await add_word(alice, "cat", "кот", example_en="A Cat sleeps.", example_ru="Кот спит.")
    await add_word(alice, "cow", "корова", example_en="cow and cow")
    await add_word(bob, "fox", "лиса", example_en="A fox is here.")
    result = await start(alice)
    assert result.status_code == 201 and result.headers["cache-control"] == "no-store"
    session = result.json()
    assert session["mode"] == "cloze" and session["direction"] == "en_en"
    assert len(session["items"]) == 1
    item = session["items"][0]
    assert item == {"id": item["id"], "prompt": "A ____ sleeps.", "options": []}
    assert "Cat" not in result.text and "Кот" not in result.text and "fox" not in result.text

    url = f"/api/training/items/{item['id']}"
    response = await alice.post(f"{url}/answer", json={"text": " CAT. "})
    assert response.json() == {
        "outcome": "answered",
        "correct": True,
        "submitted_text": " CAT. ",
        "expected_answers": ["cat"],
        "delta": 8,
        "progress": 8,
    }
    assert response.headers["cache-control"] == "no-store"


async def test_no_eligible_and_other_owner_only(alice: Client, bob: Client) -> None:
    await add_word(alice, "cat", "кот", example_en="category")
    await add_word(bob, "cat", "кот", example_en="a cat sleeps")
    result = await start(alice)
    assert result.status_code == 409
    assert result.json() == {"detail": "no_eligible_cloze_examples"}
    assert result.headers["cache-control"] == "no-store"
    assert (await alice.get("/api/words")).json()[0]["progress"] == 0
    assert (await start(bob)).status_code == 201


async def test_size_and_progress_order_use_only_eligible_words(app: FastAPI, alice: Client) -> None:
    fast = await add_word(alice, "cat", "кот", example_en="a cat sleeps")
    slow = await add_word(alice, "dog", "пёс", example_en="a dog sleeps")
    await add_word(alice, "cow", "корова", example_en="many cows sleep")
    await set_progress(app, fast["id"], 20)
    await set_progress(app, slow["id"], 5)
    response = await start(alice, size=1)
    assert response.status_code == 201
    items = response.json()["items"]
    assert len(items) == 1
    assert items[0]["prompt"] == "a ____ sleeps"
    result = await alice.post(f"/api/training/items/{items[0]['id']}/reveal")
    assert result.json()["expected_answers"] == ["dog"]
    words = {entry["id"]: entry["progress"] for entry in (await alice.get("/api/words")).json()}
    assert words[fast["id"]] == 20 and words[slow["id"]] == 5


@pytest.mark.parametrize(
    ("mode", "direction"),
    [
        ("cloze", "en_ru"),
        ("cloze", "ru_en"),
        ("choice", "en_en"),
        ("cards", "en_en"),
        ("input", "en_en"),
    ],
)
async def test_invalid_mode_direction(alice: Client, mode: str, direction: str) -> None:
    response = await alice.post(
        "/api/training/sessions", json={"mode": mode, "direction": direction}
    )
    assert response.status_code == 422


async def test_strict_answers_and_cloze_security(alice: Client, bob: Client) -> None:
    word = await add_word(alice, "cat", "кот", example_en="a cat")
    item = (await start(alice)).json()["items"][0]
    base = f"/api/training/items/{item['id']}"
    for endpoint, data in [("answer", {"text": "cat"}), ("reveal", None), ("skip", None)]:
        response = await bob.post(f"{base}/{endpoint}", json=data)
        assert response.status_code == 404 and response.headers["cache-control"] == "no-store"
        del alice.headers["X-CSRF-Token"]
        response = await alice.post(f"{base}/{endpoint}", json=data)
        assert response.status_code == 403 and response.headers["cache-control"] == "no-store"
        alice.headers["X-CSRF-Token"] = alice.csrf
    for invalid in [{"option": 1}, {"grade": "good"}, {"text": ""}, {"text": "cat", "option": 0}]:
        assert (await alice.post(f"{base}/answer", json=invalid)).status_code == 422
    assert (await alice.delete(f"/api/words/{word['id']}")).status_code == 204
    assert (await alice.post(f"{base}/reveal")).status_code == 404


@pytest.mark.parametrize(
    ("answer", "initial", "delta", "expected"),
    [
        ("cat", 98, 8, 106),
        ("wrong", 2, -4, 0),
    ],
)
async def test_typed_deltas_allow_progress_above_100(
    app: FastAPI, alice: Client, answer: str, initial: int, delta: int, expected: int
) -> None:
    word = await add_word(alice, "cat", "кот", example_en="a cat")
    await set_progress(app, word["id"], initial)
    item = (await start(alice)).json()["items"][0]
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"text": answer})
    assert response.json()["correct"] is (answer == "cat")
    assert response.json()["delta"] == delta
    assert response.json()["progress"] == expected


async def test_snapshot_difficulty_and_content_version(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот", example_en="a cat sleeps")
    await set_progress(app, word["id"], 50)
    await alice.put("/api/auth/settings", json={"difficulty": "very_easy"})
    item = (await start(alice)).json()["items"][0]
    await alice.put("/api/auth/settings", json={"difficulty": "very_hard"})
    response = await alice.put(
        f"/api/words/{word['id']}",
        json={"headword": "cat", "translations": ["кот"], "example_en": "a cat runs"},
    )
    assert response.json()["progress"] == 50
    assert item["prompt"] == "a ____ sleeps"
    result = await alice.post(f"/api/training/items/{item['id']}/answer", json={"text": "cat"})
    assert result.json()["delta"] == 20 and result.json()["progress"] == 70
    item = (await start(alice)).json()["items"][0]
    await alice.put(
        f"/api/words/{word['id']}",
        json={"headword": "cat", "translations": ["кошка"], "example_en": "a cat runs"},
    )
    result = await alice.post(f"/api/training/items/{item['id']}/answer", json={"text": "cat"})
    assert result.json()["correct"] is True
    assert result.json()["expected_answers"] == ["cat"]
    assert result.json()["delta"] == 0 and result.json()["progress"] == 0


async def test_headword_edit_keeps_private_snapshot_without_progress_effect(
    app: FastAPI, alice: Client
) -> None:
    word = await add_word(alice, "cat", "кот", example_en="a cat sleeps")
    await set_progress(app, word["id"], 50)
    item = (await start(alice)).json()["items"][0]
    changed = await alice.put(
        f"/api/words/{word['id']}",
        json={"headword": "dog", "translations": ["кот"], "example_en": "a dog runs"},
    )
    assert changed.status_code == 200 and changed.json()["progress"] == 0
    assert item["prompt"] == "a ____ sleeps"
    url = f"/api/training/items/{item['id']}"
    result = (await alice.post(f"{url}/answer", json={"text": "cat"})).json()
    assert result["correct"] is True and result["expected_answers"] == ["cat"]
    assert result["delta"] == 0 and result["progress"] == 0
    assert (await alice.post(f"{url}/reveal")).json() == result


@pytest.mark.parametrize("action", ["reveal", "skip"])
async def test_cloze_assistance_and_skip_are_terminal(alice: Client, action: str) -> None:
    await add_word(alice, "cat", "кот", example_en="a cat")
    item = (await start(alice)).json()["items"][0]
    url = f"/api/training/items/{item['id']}"
    response = await alice.post(f"{url}/{action}")
    body = response.json()
    assert body["outcome"] == ("assisted" if action == "reveal" else "skipped")
    assert body["delta"] == 0 and body["progress"] == 0
    if action == "reveal":
        assert body["expected_answers"] == ["cat"]
    else:
        assert "expected_answers" not in body
    assert (await alice.post(f"{url}/answer", json={"text": "cat"})).json() == body
    assert (await alice.post(f"{url}/skip")).json() == body


async def test_cloze_races_use_one_terminal_result(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот", example_en="a cat")
    await set_progress(app, word["id"], 50)
    item = (await start(alice)).json()["items"][0]
    url = f"/api/training/items/{item['id']}"
    results = await asyncio.gather(
        alice.post(f"{url}/answer", json={"text": "cat"}),
        alice.post(f"{url}/reveal"),
        alice.post(f"{url}/skip"),
    )
    assert all(result.status_code == 200 for result in results)
    body = results[0].json()
    assert all(result.json() == body for result in results)
    assert body["delta"] == (8 if body["outcome"] == "answered" else 0)
    assert body["progress"] == 50 + body["delta"]


async def test_long_example_is_not_truncated(alice: Client) -> None:
    example = "a cat" + "!" * 1995
    assert len(example) == 2000
    await add_word(alice, "cat", "кот", example_en=example)
    item = (await start(alice)).json()["items"][0]
    assert item["prompt"] == "a ____" + "!" * 1995


@pytest.mark.parametrize("blocking", ["cloze", "long"])
def test_migration_preserves_rows_and_refuses_unsafe_downgrade(
    tmp_path: Path, blocking: str
) -> None:
    file = tmp_path / "before_cloze.db"
    config = alembic_config(f"sqlite+aiosqlite:///{file}")
    command.upgrade(config, "3fae1c714a90")
    with sqlite3.connect(file) as db:
        db.execute(
            "INSERT INTO users (id, login, password_hash, is_admin, difficulty, created_at) "
            "VALUES ('u', 'alice', 'hash', 0, 'medium', '2026-01-01')"
        )
        db.execute(
            "INSERT INTO words (id, owner_id, headword, normalized_headword, progress, "
            "content_version, created_at, updated_at) "
            "VALUES ('w', 'u', 'cat', 'cat', 12, 1, '2026-01-01', '2026-01-01')"
        )
        db.execute(
            "INSERT INTO training_sessions (id, owner_id, mode, direction, difficulty, created_at) "
            "VALUES ('s', 'u', 'input', 'en_ru', 'medium', '2026-01-01')"
        )
        db.execute(
            "INSERT INTO training_items (id, session_id, word_id, word_content_version, position, "
            "prompt, options, expected_answers, submitted_text, is_correct, delta, "
            "answered_at, outcome) VALUES ('i', 's', 'w', 1, 0, 'cat', '[]', "
            "'[\"кот\"]', 'кот', 1, 8, '2026-01-01', 'answered')"
        )
    command.upgrade(config, "head")
    with sqlite3.connect(file) as db:
        row = db.execute(
            "SELECT prompt, expected_answers, submitted_text, is_correct, delta, outcome "
            "FROM training_items WHERE id='i'"
        ).fetchone()
        assert row == ("cat", '["кот"]', "кот", 1, 8, "answered")
        if blocking == "cloze":
            db.execute("UPDATE training_sessions SET mode='cloze', direction='en_en'")
        else:
            db.execute("UPDATE training_items SET prompt = ?", ("x" * 201,))
    with pytest.raises(RuntimeError, match="Cannot downgrade"):
        command.downgrade(config, "3fae1c714a90")
    with sqlite3.connect(file) as db:
        if blocking == "cloze":
            assert db.execute("SELECT mode FROM training_sessions").fetchone() == ("cloze",)
        else:
            assert db.execute("SELECT length(prompt) FROM training_items").fetchone() == (201,)
