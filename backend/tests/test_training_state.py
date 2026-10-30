import asyncio
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from fastapi import FastAPI

from lexicona.db import Database
from lexicona.models import TrainingItem, Word
from tests.conftest import Client, add_word
from tests.test_app import alembic_config
from tests.test_words import set_progress


async def set_state(client: Client, word_id: str, excluded: bool) -> Any:
    return await client.patch(f"/api/words/{word_id}/training", json={"is_excluded": excluded})


async def start(client: Client, mode: str = "input") -> dict[str, Any]:
    direction = "en_en" if mode == "cloze" else "en_ru"
    response = await client.post(
        "/api/training/sessions", json={"mode": mode, "direction": direction, "size": 1}
    )
    assert response.status_code == 201, response.text
    return response.json()["items"][0]  # type: ignore[no-any-return]


async def test_state_toggle_owner_csrf_validation_and_lists(
    app: FastAPI, alice: Client, bob: Client
) -> None:
    word = await add_word(alice, "cat", "кот", note="pet")
    await set_progress(app, word["id"], 158)
    await add_word(alice, "dog", "собака")
    url = f"/api/words/{word['id']}/training"
    response = await bob.patch(url, json={"is_excluded": True})
    assert response.status_code == 404 and response.headers["cache-control"] == "no-store"
    del alice.headers["X-CSRF-Token"]
    response = await alice.patch(url, json={"is_excluded": True})
    assert response.status_code == 403 and response.headers["cache-control"] == "no-store"
    alice.headers["X-CSRF-Token"] = alice.csrf
    for invalid in [{"is_excluded": 1}, {"is_excluded": "true"}, {}, {"is_excluded": True, "x": 1}]:
        assert (await alice.patch(url, json=invalid)).status_code == 422
    for _ in range(2):
        response = await set_state(alice, word["id"], True)
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        assert response.json()["is_excluded"] is True and response.json()["progress"] == 158
    assert (await alice.get(f"/api/words/{word['id']}")).json()["note"] == "pet"
    assert [w["headword"] for w in (await alice.get("/api/words")).json()] == ["dog"]
    assert [
        w["headword"]
        for w in (
            await alice.get(
                "/api/words", params={"training": "excluded", "q": "КОТ", "sort": "progress_desc"}
            )
        ).json()
    ] == ["cat"]
    assert len((await alice.get("/api/words", params={"training": "all"})).json()) == 2
    assert (await alice.get("/api/words", params={"training": "invalid"})).status_code == 422
    database: Database = app.state.db
    async with database.sessions() as db:
        actual = await db.get(Word, word["id"])
        assert actual is not None and actual.training_version == 2 and actual.content_version == 1
    response = await alice.put(
        f"/api/words/{word['id']}",
        json={"headword": "Cat", "translations": ["Кот"], "note": "pet"},
    )
    assert response.json()["is_excluded"] is True and response.json()["progress"] == 158
    for _ in range(2):
        assert (await set_state(alice, word["id"], False)).json()["is_excluded"] is False
    async with database.sessions() as db:
        actual = await db.get(Word, word["id"])
        assert actual is not None and actual.training_version == 3 and actual.content_version == 1


@pytest.mark.parametrize("mode", ["choice", "input", "cards", "cloze"])
@pytest.mark.parametrize("initial", [98, 100, 150])
async def test_all_modes_keep_progress_above_100(
    app: FastAPI, alice: Client, mode: str, initial: int
) -> None:
    word = await add_word(alice, "cat", "кот", example_en="a cat")
    await set_progress(app, word["id"], initial)
    if mode == "choice":
        for headword, translation in [("dog", "собака"), ("fox", "лиса"), ("cow", "корова")]:
            added = await add_word(alice, headword, translation)
            await set_progress(app, added["id"], initial + 10)
    item = await start(alice, mode)
    payload: dict[str, Any]
    if mode == "choice":
        database: Database = app.state.db
        async with database.sessions() as db:
            record = await db.get(TrainingItem, item["id"])
            assert record is not None
            payload = {"option": record.correct_option}
    elif mode == "cards":
        assert (await alice.post(f"/api/training/items/{item['id']}/reveal")).status_code == 200
        payload = {"grade": "good"}
    else:
        payload = {"text": "cat" if mode == "cloze" else "кот"}
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json=payload)
    assert response.status_code == 200
    assert response.json()["progress"] == initial + (4 if mode in ("choice", "cards") else 8)
    assert (await alice.get(f"/api/words/{word['id']}")).json()["is_excluded"] is False


@pytest.mark.parametrize("mode", ["input", "cards", "cloze", "choice"])
@pytest.mark.parametrize("action", ["answer", "reveal", "skip"])
@pytest.mark.parametrize("restore", [True, False])
async def test_exclusion_invalidates_open_item_without_leaking(
    app: FastAPI, alice: Client, mode: str, action: str, restore: bool
) -> None:
    word = await add_word(alice, "cat", "кот", example_en="a cat")
    await set_progress(app, word["id"], 50)
    if mode == "choice":
        for en, ru in [("dog", "собака"), ("fox", "лиса"), ("cow", "корова")]:
            other = await add_word(alice, en, ru)
            await set_progress(app, other["id"], 60)
    item = await start(alice, mode)
    base = f"/api/training/items/{item['id']}"
    if mode == "cards" and action == "answer":
        assert (await alice.post(f"{base}/reveal")).json()["outcome"] == "revealed"
    assert (await set_state(alice, word["id"], True)).status_code == 200
    if restore:
        assert (await set_state(alice, word["id"], False)).status_code == 200
    payload = (
        {"option": 0}
        if mode == "choice"
        else {"grade": "good"}
        if mode == "cards"
        else {"text": "cat" if mode == "cloze" else "кот"}
    )
    response = await alice.post(f"{base}/{action}", json=payload if action == "answer" else None)
    result = {
        "outcome": "unavailable",
        "reason": "training_state_changed",
        "delta": 0,
        "progress": 50,
    }
    assert response.status_code == 200 and response.json() == result
    assert (await alice.post(f"{base}/skip")).json() == result
    assert (await alice.post(f"{base}/reveal")).json() == result
    assert (await alice.post(f"{base}/answer", json=payload)).json() == result
    database: Database = app.state.db
    async with database.sessions() as db:
        saved = await db.get(TrainingItem, item["id"])
        assert (
            saved is not None and saved.outcome == "unavailable" and saved.answered_at is not None
        )
        assert saved.is_correct is None and saved.submitted_text is None
        assert saved.chosen_option is None and saved.grade is None and saved.delta == 0


async def test_excluded_words_do_not_enter_choice_pool_or_distractors(alice: Client) -> None:
    for en, ru in [("cat", "кот"), ("dog", "собака"), ("fox", "лиса"), ("cow", "корова")]:
        word = await add_word(alice, en, ru)
        if en == "fox":
            await set_state(alice, word["id"], True)
    response = await alice.post("/api/training/sessions", json={"mode": "choice", "size": 10})
    assert response.status_code == 409
    fox = (await alice.get("/api/words", params={"training": "excluded"})).json()[0]
    await set_state(alice, fox["id"], False)
    response = await alice.post("/api/training/sessions", json={"mode": "choice", "size": 10})
    assert response.status_code == 201 and len(response.json()["items"]) == 4


async def test_excluded_word_not_used_even_when_choice_has_enough_active(alice: Client) -> None:
    excluded_id = ""
    for en, ru in [
        ("cat", "кот"),
        ("dog", "собака"),
        ("fox", "лиса"),
        ("cow", "корова"),
        ("wolf", "волк"),
    ]:
        word = await add_word(alice, en, ru)
        if en == "fox":
            excluded_id = word["id"]
    await set_state(alice, excluded_id, True)
    for direction in ["en_ru", "ru_en"]:
        response = await alice.post(
            "/api/training/sessions", json={"mode": "choice", "direction": direction, "size": 10}
        )
        assert response.status_code == 201 and len(response.json()["items"]) == 4
        for item in response.json()["items"]:
            assert item["prompt"] not in ("fox", "лиса")
            assert "fox" not in item["options"] and "лиса" not in item["options"]


async def test_terminal_result_precedes_later_exclusion(alice: Client) -> None:
    word = await add_word(alice, "cat", "кот")
    item = await start(alice)
    base = f"/api/training/items/{item['id']}"
    answer = (await alice.post(f"{base}/answer", json={"text": "кот"})).json()
    assert answer["outcome"] == "answered" and answer["progress"] == 8
    await set_state(alice, word["id"], True)
    assert (await alice.post(f"{base}/reveal")).json() == answer
    assert (await alice.post(f"{base}/skip")).json() == answer


async def test_answer_racing_exclusion_is_serialized(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот")
    await set_progress(app, word["id"], 50)
    item = await start(alice)
    base = f"/api/training/items/{item['id']}"
    answer, excluded = await asyncio.gather(
        alice.post(f"{base}/answer", json={"text": "кот"}),
        set_state(alice, word["id"], True),
    )
    assert answer.status_code == excluded.status_code == 200
    result = answer.json()
    assert (result["outcome"], result["delta"], result["progress"]) in [
        ("answered", 8, 58),
        ("unavailable", 0, 50),
    ]
    assert (await alice.post(f"{base}/skip")).json() == result
    assert (await alice.get(f"/api/words/{word['id']}")).json()["progress"] == result["progress"]


@pytest.mark.parametrize("action", ["reveal", "skip"])
async def test_help_or_skip_racing_exclusion_has_one_terminal_result(
    app: FastAPI, alice: Client, action: str
) -> None:
    word = await add_word(alice, "cat", "кот")
    await set_progress(app, word["id"], 50)
    item = await start(alice)
    base = f"/api/training/items/{item['id']}"
    terminal, excluded = await asyncio.gather(
        alice.post(f"{base}/{action}"), set_state(alice, word["id"], True)
    )
    assert terminal.status_code == excluded.status_code == 200
    result = terminal.json()
    assert result["outcome"] in ("assisted" if action == "reveal" else "skipped", "unavailable")
    assert result["delta"] == 0 and result["progress"] == 50
    if result["outcome"] == "assisted":
        assert result["expected_answers"] == ["кот"]
    else:
        assert "expected_answers" not in result
    assert (await alice.post(f"{base}/answer", json={"text": "кот"})).json() == result
    assert (await alice.post(f"{base}/reveal")).json() == result
    assert (await alice.post(f"{base}/skip")).json() == result
    assert (await alice.get(f"/api/words/{word['id']}")).json()["progress"] == 50


async def test_parallel_old_item_actions_after_exclusion_and_return_are_unavailable(
    app: FastAPI, alice: Client
) -> None:
    word = await add_word(alice, "cat", "кот")
    await set_progress(app, word["id"], 50)
    item = await start(alice)
    base = f"/api/training/items/{item['id']}"
    assert (await set_state(alice, word["id"], True)).status_code == 200
    assert (await set_state(alice, word["id"], False)).status_code == 200
    results = await asyncio.gather(
        alice.post(f"{base}/answer", json={"text": "кот"}),
        alice.post(f"{base}/reveal"),
        alice.post(f"{base}/skip"),
    )
    expected = {
        "outcome": "unavailable",
        "reason": "training_state_changed",
        "delta": 0,
        "progress": 50,
    }
    assert all(response.status_code == 200 and response.json() == expected for response in results)
    assert (await alice.get(f"/api/words/{word['id']}")).json()["progress"] == 50


def test_migration_preserves_children_and_safe_roundtrip(tmp_path: Path) -> None:
    file = tmp_path / "state.db"
    config = alembic_config(f"sqlite+aiosqlite:///{file}")
    command.upgrade(config, "9c7e4261ab38")
    with sqlite3.connect(file) as db:
        db.execute("PRAGMA foreign_keys=ON")
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
            "INSERT INTO word_translations (id, word_id, position, text, normalized_text) "
            "VALUES ('t', 'w', 0, 'кот', 'кот')"
        )
        db.execute(
            "INSERT INTO training_sessions (id, owner_id, mode, direction, difficulty, created_at) "
            "VALUES ('s', 'u', 'input', 'en_ru', 'medium', '2026-01-01')"
        )
        for item, outcome in [("a", "answered"), ("b", None)]:
            db.execute(
                "INSERT INTO training_items (id, session_id, word_id, word_content_version, "
                "position, prompt, options, expected_answers, outcome) VALUES (?, 's', 'w', 1, 0, "
                "'cat', '[]', '[\"кот\"]', ?)",
                (item, outcome),
            )
    for revision in ["head", "9c7e4261ab38", "head"]:
        (command.downgrade if revision == "9c7e4261ab38" else command.upgrade)(config, revision)
        with sqlite3.connect(file) as db:
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []
            assert db.execute("SELECT text FROM word_translations").fetchall() == [("кот",)]
            assert db.execute("SELECT id, outcome FROM training_items ORDER BY id").fetchall() == [
                ("a", "answered"),
                ("b", None),
            ]
            assert db.execute("SELECT progress FROM words").fetchone() == (12,)
    with sqlite3.connect(file) as db:
        db.execute("UPDATE words SET progress = 101")
    with pytest.raises(RuntimeError, match="Cannot downgrade"):
        command.downgrade(config, "9c7e4261ab38")
    with sqlite3.connect(file) as db:
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert db.execute("SELECT progress FROM words").fetchone() == (101,)
        assert db.execute("SELECT count(*) FROM word_translations").fetchone() == (1,)
        assert db.execute("SELECT count(*) FROM training_items").fetchone() == (2,)


@pytest.mark.parametrize("unsafe", ["excluded", "version", "item_version", "unavailable"])
def test_downgrade_refuses_incompatible_training_state(tmp_path: Path, unsafe: str) -> None:
    file = tmp_path / f"{unsafe}.db"
    config = alembic_config(f"sqlite+aiosqlite:///{file}")
    command.upgrade(config, "head")
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
            "INSERT INTO training_items (id, session_id, word_id, word_content_version, "
            "position, prompt, options, expected_answers) "
            "VALUES ('i', 's', 'w', 1, 0, 'cat', '[]', '[\"кот\"]')"
        )
        if unsafe == "excluded":
            db.execute("UPDATE words SET is_excluded = 1")
        elif unsafe == "version":
            db.execute("UPDATE words SET training_version = 2")
        elif unsafe == "item_version":
            db.execute("UPDATE training_items SET word_training_version = 2")
        else:
            db.execute("UPDATE training_items SET outcome = 'unavailable'")
    with pytest.raises(RuntimeError, match="Cannot downgrade"):
        command.downgrade(config, "9c7e4261ab38")
    with sqlite3.connect(file) as db:
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert db.execute("SELECT count(*) FROM words").fetchone() == (1,)
        assert db.execute("SELECT count(*) FROM training_items").fetchone() == (1,)
