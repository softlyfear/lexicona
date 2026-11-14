import asyncio
import sqlite3
from pathlib import Path
from typing import Any, cast

import pytest
from alembic import command
from fastapi import FastAPI

from lexicona.infrastructure.db import Database
from lexicona.infrastructure.models import TrainingItem
from tests.conftest import Client, add_legacy_card_item, add_word
from tests.test_app import alembic_config
from tests.test_words import set_progress


async def create_item(app: FastAPI, client: Client, mode: str, direction: str) -> dict[str, Any]:
    if mode == "cards":
        words = (await client.get("/api/words")).json()
        word = next(word for word in words if word["headword"] == "cat")
        return await add_legacy_card_item(app, client, word["id"], direction)
    result = await client.post(
        "/api/training/sessions", json={"mode": mode, "direction": direction, "size": 10}
    )
    assert result.status_code == 201
    prompt = "cat" if direction == "en_ru" else "кот, кошка"
    return cast(
        dict[str, Any], next(item for item in result.json()["items"] if item["prompt"] == prompt)
    )


async def seed(client: Client) -> dict[str, Any]:
    word = await add_word(client, "cat", "кот", "кошка")
    for en, ru in [
        ("dog", "собака"),
        ("cow", "корова"),
        ("fox", "лиса"),
        ("owl", "сова"),
        ("wolf", "волк"),
    ]:
        await add_word(client, en, ru)
    return cast(dict[str, Any], word)


@pytest.mark.parametrize("mode", ["choice", "input"])
@pytest.mark.parametrize("direction", ["en_ru", "ru_en"])
async def test_assistance_is_terminal_and_uses_snapshot(
    app: FastAPI, alice: Client, mode: str, direction: str
) -> None:
    word = await seed(alice)
    await set_progress(app, word["id"], 53)
    item = await create_item(app, alice, mode, direction)
    assert set(item) == {"id", "prompt", "options", "transcription", "word_id"}

    # Cosmetic edits and subsequent semantic edits cannot rewrite the private snapshot.
    edit = await alice.put(
        f"/api/words/{word['id']}",
        json={"headword": "Cat", "translations": ["Кот", "кошка"], "note": "pet"},
    )
    assert edit.json()["progress"] == 53
    edit = await alice.put(
        f"/api/words/{word['id']}", json={"headword": "cat", "translations": ["котик"]}
    )
    assert edit.json()["progress"] == 0
    await set_progress(app, word["id"], 53)

    url = f"/api/training/items/{item['id']}"
    response = await alice.post(f"{url}/reveal")
    assert response.status_code == 200
    result = response.json()
    if mode == "choice":
        expected = ["кот, кошка"] if direction == "en_ru" else ["cat"]
        assert result["correct_option"] == item["options"].index(expected[0])
    else:
        expected = ["кот", "кошка"] if direction == "en_ru" else ["cat"]
        assert "correct_option" not in result
    assert result["outcome"] == "assisted"
    assert result["expected_answers"] == expected
    assert result["delta"] == 0 and result["progress"] == 53
    assert response.headers["cache-control"] == "no-store"
    payload = {"option": 0} if mode == "choice" else {"text": "кот"}
    for retry in (
        await alice.post(f"{url}/answer", json=payload),
        await alice.post(f"{url}/skip"),
        await alice.post(f"{url}/reveal"),
    ):
        assert retry.json() == result
    assert (await alice.get("/api/words")).json()
    database: Database = app.state.db
    async with database.sessions() as db:
        recorded = await db.get(TrainingItem, item["id"])
        assert recorded is not None
        assert recorded.outcome == "assisted" and recorded.answered_at is not None
        assert recorded.delta == 0
        assert recorded.is_correct is None and recorded.grade is None
        assert recorded.chosen_option is None and recorded.submitted_text is None


@pytest.mark.parametrize("mode", ["choice", "input", "cards"])
@pytest.mark.parametrize("direction", ["en_ru", "ru_en"])
async def test_skip_is_terminal_and_does_not_leak_or_change_progress(
    app: FastAPI, alice: Client, mode: str, direction: str
) -> None:
    word = await seed(alice)
    await set_progress(app, word["id"], 53)
    item = await create_item(app, alice, mode, direction)
    url = f"/api/training/items/{item['id']}"
    response = await alice.post(f"{url}/skip")
    result = {"outcome": "skipped", "delta": 0, "progress": 53}
    assert response.json() == result
    assert response.headers["cache-control"] == "no-store"
    payload = (
        {"option": 0}
        if mode == "choice"
        else ({"text": "кот"} if mode == "input" else {"grade": "good"})
    )
    assert (await alice.post(f"{url}/answer", json=payload)).json() == result
    assert (await alice.post(f"{url}/reveal")).json() == result
    assert (await alice.post(f"{url}/skip")).json() == result
    database: Database = app.state.db
    async with database.sessions() as db:
        recorded = await db.get(TrainingItem, item["id"])
        assert recorded is not None
        assert recorded.outcome == "skipped" and recorded.answered_at is not None
        assert recorded.delta == 0 and recorded.revealed_at is None
        assert recorded.is_correct is None and recorded.grade is None
        assert recorded.chosen_option is None and recorded.submitted_text is None


async def test_revealed_card_can_be_skipped_without_grade(app: FastAPI, alice: Client) -> None:
    await add_word(alice, "cat", "кот")
    item = await create_item(app, alice, "cards", "en_ru")
    url = f"/api/training/items/{item['id']}"
    assert (await alice.post(f"{url}/reveal")).json() == {
        "outcome": "revealed",
        "expected_answers": ["кот"],
    }
    skipped = {"outcome": "skipped", "delta": 0, "progress": 0}
    assert (await alice.post(f"{url}/skip")).json() == skipped
    assert (await alice.post(f"{url}/reveal")).json() == skipped
    assert (await alice.post(f"{url}/answer", json={"grade": "good"})).json() == skipped


@pytest.mark.parametrize("difficulty", ["very_easy", "easy", "medium", "hard", "very_hard"])
@pytest.mark.parametrize("action", ["reveal", "skip"])
async def test_help_and_skip_keep_progress_at_every_difficulty(
    app: FastAPI, alice: Client, difficulty: str, action: str
) -> None:
    word = await add_word(alice, "cat", "кот")
    await set_progress(app, word["id"], 53)
    assert (
        await alice.put("/api/auth/settings", json={"difficulty": difficulty})
    ).status_code == 200
    item = await create_item(app, alice, "input", "en_ru")
    result = await alice.post(f"/api/training/items/{item['id']}/{action}")
    assert result.status_code == 200
    assert result.json()["outcome"] == ("assisted" if action == "reveal" else "skipped")
    assert result.json()["delta"] == 0
    assert result.json()["progress"] == 53
    words = (await alice.get("/api/words")).json()
    assert next(entry for entry in words if entry["id"] == word["id"])["progress"] == 53


@pytest.mark.parametrize("mode", ["choice", "input", "cards"])
async def test_racing_terminal_actions_have_one_canonical_result(
    app: FastAPI, alice: Client, mode: str
) -> None:
    word = await seed(alice)
    await set_progress(app, word["id"], 50)
    item = await create_item(app, alice, mode, "en_ru")
    url = f"/api/training/items/{item['id']}"
    if mode == "cards":
        await alice.post(f"{url}/reveal")
        action = alice.post(f"{url}/answer", json={"grade": "good"})
        responses = list(await asyncio.gather(action, alice.post(f"{url}/skip")))
    else:
        payload = {"option": 0} if mode == "choice" else {"text": "кот"}
        responses = list(
            await asyncio.gather(
                alice.post(f"{url}/answer", json=payload),
                alice.post(f"{url}/reveal"),
                alice.post(f"{url}/skip"),
            )
        )
    assert all(response.status_code == 200 for response in responses)
    result = responses[0].json()
    assert all(response.json() == result for response in responses)
    if result["outcome"] == "answered":
        change = 4 if mode in ("cards", "choice") else 8
        if mode == "choice" and not result["correct"]:
            change = -4
        assert result["delta"] == change and result["progress"] == 50 + change
    else:
        assert result["outcome"] in ("assisted", "skipped")
        assert result["delta"] == 0 and result["progress"] == 50
    assert (await alice.post(f"{url}/skip")).json() == result


@pytest.mark.parametrize("endpoint", ["reveal", "skip"])
async def test_assistance_endpoints_owner_csrf_no_store_and_deleted_item(
    app: FastAPI, alice: Client, bob: Client, endpoint: str
) -> None:
    word = await add_word(alice, "cat", "кот")
    item = await create_item(app, alice, "input", "en_ru")
    url = f"/api/training/items/{item['id']}/{endpoint}"
    response = await bob.post(url)
    assert response.status_code == 404 and response.headers["cache-control"] == "no-store"
    del alice.headers["X-CSRF-Token"]
    response = await alice.post(url)
    assert response.status_code == 403 and response.headers["cache-control"] == "no-store"
    alice.headers["X-CSRF-Token"] = alice.csrf
    assert (await alice.delete(f"/api/words/{word['id']}")).status_code == 204
    response = await alice.post(url)
    assert response.status_code == 200 and response.json()["reason"] == "word_deleted"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("outcome", ["assisted", "skipped"])
def test_outcome_migration_backfills_and_refuses_loss(tmp_path: Path, outcome: str) -> None:
    file = tmp_path / "before_outcome.db"
    config = alembic_config(f"sqlite+aiosqlite:///{file}")
    command.upgrade(config, "e14c8f510e43")
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
        for item, answered_at in [("open", None), ("closed", "2026-01-01")]:
            db.execute(
                "INSERT INTO training_items (id, session_id, word_id, word_content_version, "
                "position, prompt, options, expected_answers, answered_at) "
                "VALUES (?, 's', 'w', 1, 0, 'cat', '[]', '[\"кот\"]', ?)",
                (item, answered_at),
            )
    command.upgrade(config, "head")
    with sqlite3.connect(file) as db:
        assert db.execute(
            "SELECT id, outcome, answered_at FROM training_items ORDER BY id"
        ).fetchall() == [("closed", "answered", "2026-01-01"), ("open", None, None)]
        db.execute("UPDATE training_items SET outcome = ? WHERE id = 'open'", (outcome,))
    with pytest.raises(RuntimeError, match="Cannot downgrade"):
        command.downgrade(config, "e14c8f510e43")
    with sqlite3.connect(file) as db:
        assert db.execute("SELECT outcome FROM training_items WHERE id = 'open'").fetchone() == (
            outcome,
        )
