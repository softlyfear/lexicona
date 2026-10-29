import asyncio
import sqlite3
from pathlib import Path
from typing import Any, cast

import pytest
from alembic import command
from fastapi import FastAPI

from lexicona.db import Database
from lexicona.models import TrainingItem
from tests.conftest import Client, add_word
from tests.test_app import alembic_config
from tests.test_words import set_progress


async def start_card(client: Client, direction: str = "en_ru") -> dict[str, Any]:
    response = await client.post(
        "/api/training/sessions", json={"mode": "cards", "direction": direction, "size": 1}
    )
    assert response.status_code == 201, response.text
    return cast(dict[str, Any], response.json()["items"][0])


@pytest.mark.parametrize(
    ("direction", "prompt", "expected"),
    [("en_ru", "cat", ["кот", "кошка"]), ("ru_en", "кот", ["cat"])],
)
async def test_cards_hide_answers_until_reveal(
    alice: Client, direction: str, prompt: str, expected: list[str]
) -> None:
    await add_word(alice, "cat", "кот", "кошка")
    item = await start_card(alice, direction)
    assert item == {"id": item["id"], "prompt": prompt, "options": []}
    reveal = f"/api/training/items/{item['id']}/reveal"
    answer = f"/api/training/items/{item['id']}/answer"
    assert (await alice.post(answer, json={"grade": "good"})).status_code == 422
    for _ in range(2):
        response = await alice.post(reveal)
        assert response.status_code == 200
        assert response.json() == {"expected_answers": expected}
        assert response.headers["cache-control"] == "no-store"
    assert (await alice.get("/api/words")).json()[0]["progress"] == 0
    response = await alice.post(answer, json={"grade": "good"})
    assert response.json() == {
        "grade": "good",
        "expected_answers": expected,
        "delta": 4,
        "progress": 4,
    }
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    ("grade", "delta", "after"),
    [("again", -4, 46), ("hard", 0, 50), ("good", 4, 54), ("easy", 4, 54)],
)
async def test_card_ratings_are_subjective(
    app: FastAPI, alice: Client, grade: str, delta: int, after: int
) -> None:
    word = await add_word(alice, "cat", "кот")
    await set_progress(app, word["id"], 50)
    item = await start_card(alice)
    await alice.post(f"/api/training/items/{item['id']}/reveal")
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"grade": grade})
    assert response.json() == {
        "grade": grade,
        "expected_answers": ["кот"],
        "delta": delta,
        "progress": after,
    }
    database: Database = app.state.db
    async with database.sessions() as db:
        recorded = await db.get(TrainingItem, item["id"])
        assert recorded is not None and recorded.is_correct is None


async def test_cards_owner_csrf_and_strict_payload(alice: Client, bob: Client) -> None:
    await add_word(alice, "cat", "кот")
    item = await start_card(alice)
    reveal = f"/api/training/items/{item['id']}/reveal"
    answer = f"/api/training/items/{item['id']}/answer"
    assert (await bob.post(reveal)).status_code == 404
    assert (await bob.post(answer, json={"grade": "good"})).status_code == 404
    del alice.headers["X-CSRF-Token"]
    assert (await alice.post(reveal)).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    assert (await alice.post(reveal)).status_code == 200
    del alice.headers["X-CSRF-Token"]
    assert (await alice.post(answer, json={"grade": "good"})).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    for data in (
        {"grade": "perfect"},
        {"text": "кот"},
        {"option": 0},
        {"grade": "good", "option": 0},
    ):
        assert (await alice.post(answer, json=data)).status_code == 422
    assert (await alice.post(answer, json={"grade": "good"})).json()["progress"] == 4


async def test_concurrent_card_scores_apply_once(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот")
    await set_progress(app, word["id"], 50)
    item = await start_card(alice)
    await alice.post(f"/api/training/items/{item['id']}/reveal")
    url = f"/api/training/items/{item['id']}/answer"
    responses = await asyncio.gather(
        *[alice.post(url, json={"grade": grade}) for grade in ["again", "good", "hard", "easy"]]
    )
    results = [r.json() for r in responses]
    assert all(r.status_code == 200 for r in responses)
    assert all(result == results[0] for result in results)
    first = results[0]
    assert (first["grade"], first["delta"], first["progress"]) in {
        ("again", -4, 46),
        ("hard", 0, 50),
        ("good", 4, 54),
        ("easy", 4, 54),
    }
    assert (await alice.post(url, json={"grade": "good"})).json() == first


async def test_card_snapshot_and_frozen_difficulty(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот", "кошка")
    await set_progress(app, word["id"], 30)
    await alice.put("/api/auth/settings", json={"difficulty": "very_easy"})
    item = await start_card(alice)
    await alice.put("/api/auth/settings", json={"difficulty": "very_hard"})
    await alice.put(f"/api/words/{word['id']}", json={"headword": "cat", "translations": ["котик"]})
    assert (await alice.post(f"/api/training/items/{item['id']}/reveal")).json() == {
        "expected_answers": ["кот", "кошка"]
    }
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"grade": "good"})
    assert response.json()["delta"] == 0
    assert response.json()["progress"] == 0
    item = await start_card(alice)
    await alice.put("/api/auth/settings", json={"difficulty": "very_easy"})
    await alice.post(f"/api/training/items/{item['id']}/reveal")
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"grade": "good"})
    assert response.json()["delta"] == 2  # very_hard frozen at creation


async def test_non_card_reveal_is_rejected(alice: Client) -> None:
    await add_word(alice, "cat", "кот")
    response = await alice.post("/api/training/sessions", json={"mode": "input"})
    item = response.json()["items"][0]
    assert (await alice.post(f"/api/training/items/{item['id']}/reveal")).status_code == 422
    assert (
        await alice.post(f"/api/training/items/{item['id']}/answer", json={"grade": "good"})
    ).status_code == 422


@pytest.mark.parametrize(
    ("grade", "delta", "progress"),
    [("again", -10, 40), ("hard", 0, 50), ("good", 10, 60), ("easy", 10, 60)],
)
async def test_each_card_grade_uses_frozen_difficulty(
    app: FastAPI, alice: Client, grade: str, delta: int, progress: int
) -> None:
    word = await add_word(alice, "cat", "кот")
    await set_progress(app, word["id"], 50)
    await alice.put("/api/auth/settings", json={"difficulty": "very_easy"})
    item = await start_card(alice)
    await alice.put("/api/auth/settings", json={"difficulty": "very_hard"})
    await alice.post(f"/api/training/items/{item['id']}/reveal")
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"grade": grade})
    assert response.status_code == 200
    assert response.json()["delta"] == delta
    assert response.json()["progress"] == progress


@pytest.mark.parametrize(
    ("initial", "grade", "delta", "expected"),
    [(2, "again", -4, 0), (98, "good", 4, 100)],
)
async def test_card_progress_clamps_at_bounds(
    app: FastAPI, alice: Client, initial: int, grade: str, delta: int, expected: int
) -> None:
    word = await add_word(alice, "cat", "кот")
    await set_progress(app, word["id"], initial)
    item = await start_card(alice)
    await alice.post(f"/api/training/items/{item['id']}/reveal")
    result = await alice.post(f"/api/training/items/{item['id']}/answer", json={"grade": grade})
    assert result.json()["delta"] == delta
    assert result.json()["progress"] == expected


async def test_card_cosmetic_edit_preserves_snapshot_and_score(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот", "кошка")
    await set_progress(app, word["id"], 30)
    item = await start_card(alice)
    update = await alice.put(
        f"/api/words/{word['id']}",
        json={"headword": "Cat", "translations": ["Кот", "кошка"], "note": "pet"},
    )
    assert update.status_code == 200
    reveal = await alice.post(f"/api/training/items/{item['id']}/reveal")
    assert reveal.json() == {"expected_answers": ["кот", "кошка"]}
    result = await alice.post(f"/api/training/items/{item['id']}/answer", json={"grade": "good"})
    assert result.json()["delta"] == 4
    assert result.json()["progress"] == 34


async def test_choice_item_cannot_be_revealed_as_card(alice: Client) -> None:
    for en, ru in [("cat", "кот"), ("dog", "собака"), ("cow", "корова"), ("fox", "лиса")]:
        await add_word(alice, en, ru)
    session = await alice.post("/api/training/sessions", json={"mode": "choice"})
    item = session.json()["items"][0]
    reveal = await alice.post(f"/api/training/items/{item['id']}/reveal")
    assert reveal.status_code == 422
    assert reveal.headers["cache-control"] == "no-store"


def test_card_migration_refuses_data_loss(tmp_path: Path) -> None:
    file = tmp_path / "existing.db"
    config = alembic_config(f"sqlite+aiosqlite:///{file}")
    command.upgrade(config, "head")
    with sqlite3.connect(file) as db:
        db.execute(
            "INSERT INTO users (id, login, password_hash, is_admin, difficulty, created_at) "
            "VALUES ('u', 'alice', 'hash', 0, 'medium', '2026-01-01')"
        )
        db.execute(
            "INSERT INTO training_sessions (id, owner_id, mode, direction, difficulty, created_at) "
            "VALUES ('s', 'u', 'cards', 'en_ru', 'medium', '2026-01-01')"
        )
    with pytest.raises(RuntimeError, match="Cannot downgrade"):
        command.downgrade(config, "0d31c9a7e210")
    with sqlite3.connect(file) as db:
        assert db.execute("SELECT mode FROM training_sessions WHERE id = 's'").fetchone() == (
            "cards",
        )


def test_card_migration_keeps_existing_choice_and_typed_answers(tmp_path: Path) -> None:
    file = tmp_path / "before_cards.db"
    config = alembic_config(f"sqlite+aiosqlite:///{file}")
    command.upgrade(config, "0d31c9a7e210")
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
        for session, mode in [("c", "choice"), ("t", "input")]:
            db.execute(
                "INSERT INTO training_sessions (id, owner_id, mode, direction, difficulty, "
                "created_at) VALUES (?, 'u', ?, 'en_ru', 'medium', '2026-01-01')",
                (session, mode),
            )
        db.execute(
            "INSERT INTO training_items (id, session_id, word_id, word_content_version, position, "
            "prompt, options, correct_option, chosen_option, is_correct, delta, answered_at) "
            "VALUES ('c', 'c', 'w', 1, 0, 'cat', '[\"кот\"]', 0, 0, 1, 4, '2026-01-01')"
        )
        db.execute(
            "INSERT INTO training_items (id, session_id, word_id, word_content_version, position, "
            "prompt, options, correct_option, expected_answers, submitted_text, is_correct, "
            "delta, answered_at) VALUES ('t', 't', 'w', 1, 0, 'cat', '[]', NULL, "
            "'[\"кот\"]', 'кот', 1, 8, '2026-01-01')"
        )
    command.upgrade(config, "head")
    with sqlite3.connect(file) as db:
        rows = db.execute(
            "SELECT id, correct_option, chosen_option, expected_answers, submitted_text, "
            "is_correct, delta, revealed_at, grade FROM training_items ORDER BY id"
        ).fetchall()
        assert rows == [
            ("c", 0, 0, None, None, 1, 4, None, None),
            ("t", None, None, '["кот"]', "кот", 1, 8, None, None),
        ]
