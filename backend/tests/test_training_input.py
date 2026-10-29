import asyncio
from typing import Any, cast

import pytest
from fastapi import FastAPI

from tests.conftest import Client, add_word
from tests.test_words import set_progress


async def start_input(client: Client, direction: str = "en_ru") -> dict[str, Any]:
    response = await client.post(
        "/api/training/sessions", json={"mode": "input", "direction": direction, "size": 10}
    )
    assert response.status_code == 201, response.text
    return cast(dict[str, Any], response.json()["items"][0])


@pytest.mark.parametrize(
    ("direction", "prompt", "answer", "expected"),
    [("en_ru", "cat", "  КОШКА. ", ["кот", "кошка"]), ("ru_en", "кот", "CAT.", ["cat"])],
)
async def test_input_checks_snapshot_without_leaking(
    alice: Client, direction: str, prompt: str, answer: str, expected: list[str]
) -> None:
    await add_word(alice, "cat", "кот", "кошка")
    item = await start_input(alice, direction)
    assert item == {"id": item["id"], "prompt": prompt, "options": []}
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"text": answer})
    assert response.status_code == 200
    assert response.json() == {
        "correct": True,
        "submitted_text": answer,
        "expected_answers": expected,
        "delta": 8,
        "progress": 8,
    }
    assert response.headers["cache-control"] == "no-store"


async def test_input_invalid_answers_do_not_close_item(alice: Client) -> None:
    await add_word(alice, "cat", "кот")
    item = await start_input(alice)
    url = f"/api/training/items/{item['id']}/answer"
    for invalid in (
        {"option": 0},
        {"text": "  .  "},
        {"text": "x" * 201},
        {"text": "кот", "option": 0},
        {"text": 8},
        {},
    ):
        response = await alice.post(url, json=invalid)
        assert response.status_code == 422, invalid
    response = await alice.post(url, json={"text": "кот"})
    assert response.json()["delta"] == 8


async def test_input_retries_and_concurrent_answers_apply_once(alice: Client) -> None:
    await add_word(alice, "cat", "кот")
    item = await start_input(alice)
    url = f"/api/training/items/{item['id']}/answer"
    results = await asyncio.gather(
        *[alice.post(url, json={"text": text}) for text in ["кот", "ошибка", "кот"]]
    )
    bodies = [response.json() for response in results]
    assert all(response.status_code == 200 for response in results)
    assert all(body == bodies[0] for body in bodies)
    first = bodies[0]
    assert (first["correct"], first["delta"], first["progress"]) in {(True, 8, 8), (False, -4, 0)}
    again = await alice.post(url, json={"text": "different answer"})
    assert again.json() == first


async def test_input_snapshot_stale_meaning_and_difficulty(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот", "кошка")
    await set_progress(app, word["id"], 50)
    await alice.put("/api/auth/settings", json={"difficulty": "very_easy"})
    item = await start_input(alice)
    await alice.put("/api/auth/settings", json={"difficulty": "very_hard"})
    await alice.put(f"/api/words/{word['id']}", json={"headword": "cat", "translations": ["котик"]})
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"text": "кошка"})
    assert response.json() == {
        "correct": True,
        "submitted_text": "кошка",
        "expected_answers": ["кот", "кошка"],
        "delta": 0,
        "progress": 0,
    }
    item = await start_input(alice)
    await alice.put("/api/auth/settings", json={"difficulty": "very_easy"})
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"text": "котик"})
    assert response.json()["delta"] == 4  # very_hard was frozen at the second session start


async def test_input_other_user_and_missing_csrf(alice: Client, bob: Client) -> None:
    await add_word(alice, "cat", "кот")
    item = await start_input(alice)
    url = f"/api/training/items/{item['id']}/answer"
    assert (await bob.post(url, json={"text": "кот"})).status_code == 404
    del alice.headers["X-CSRF-Token"]
    assert (await alice.post(url, json={"text": "кот"})).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    assert (await alice.post(url, json={"text": "кот"})).json()["progress"] == 8


async def test_input_progress_bounds_and_conservative_normalization(
    app: FastAPI, alice: Client
) -> None:
    word = await add_word(alice, "can't", "не могу")
    await set_progress(app, word["id"], 98)
    item = await start_input(alice, "ru_en")
    response = await alice.post(
        f"/api/training/items/{item['id']}/answer", json={"text": " CAN’T. "}
    )
    assert response.json()["correct"] is True
    assert response.json()["progress"] == 100

    await set_progress(app, word["id"], 2)
    item = await start_input(alice, "ru_en")
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"text": "can"})
    assert response.json()["correct"] is False
    assert response.json()["delta"] == -4
    assert response.json()["progress"] == 0


async def test_input_cosmetic_edit_keeps_snapshot_and_progress(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот", "кошка")
    await set_progress(app, word["id"], 30)
    item = await start_input(alice)
    response = await alice.put(
        f"/api/words/{word['id']}",
        json={"headword": "Cat", "translations": ["Кот", "кошка"], "note": "pet"},
    )
    assert response.status_code == 200
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"text": "КОТ"})
    assert response.json()["expected_answers"] == ["кот", "кошка"]
    assert response.json()["delta"] == 8
    assert response.json()["progress"] == 38


async def test_input_session_owner_csrf_and_no_store(alice: Client, bob: Client) -> None:
    await add_word(alice, "cat", "кот")
    payload = {"mode": "input", "direction": "en_ru", "size": 1}
    response = await bob.post("/api/training/sessions", json=payload)
    assert response.status_code == 409
    assert response.json()["detail"] == "not_enough_words"
    assert response.headers["cache-control"] == "no-store"

    del alice.headers["X-CSRF-Token"]
    assert (await alice.post("/api/training/sessions", json=payload)).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    response = await alice.post("/api/training/sessions", json=payload)
    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    assert len(response.json()["items"]) == 1


async def test_input_answer_length_and_deleted_item(alice: Client) -> None:
    word = await add_word(alice, "cat", "кот")
    item = await start_input(alice)
    url = f"/api/training/items/{item['id']}/answer"
    response = await alice.post(url, json={"text": "x" * 200})
    assert response.status_code == 200
    assert response.json()["submitted_text"] == "x" * 200
    assert response.json()["correct"] is False

    item = await start_input(alice)
    assert (await alice.delete(f"/api/words/{word['id']}")).status_code == 204
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"text": "кот"})
    assert response.status_code == 404


def test_migration_preserves_choice_and_refuses_loss_of_typed_items(tmp_path: Any) -> None:
    import sqlite3

    from alembic import command

    from tests.test_app import alembic_config

    file = tmp_path / "existing.db"
    config = alembic_config(f"sqlite+aiosqlite:///{file}")
    command.upgrade(config, "b24a4bb7ec9e")
    with sqlite3.connect(file) as db:
        db.execute(
            "INSERT INTO users (id, login, password_hash, is_admin, difficulty, created_at) "
            "VALUES ('u', 'alice', 'hash', 0, 'medium', '2026-01-01')"
        )
        db.execute(
            "INSERT INTO words (id, owner_id, headword, normalized_headword, progress, "
            "content_version, created_at, updated_at) "
            "VALUES ('w', 'u', 'cat', 'cat', 0, 1, '2026-01-01', '2026-01-01')"
        )
        db.execute(
            "INSERT INTO training_sessions (id, owner_id, mode, direction, difficulty, created_at) "
            "VALUES ('s', 'u', 'choice', 'en_ru', 'medium', '2026-01-01')"
        )
        db.execute(
            "INSERT INTO training_items (id, session_id, word_id, word_content_version, position, "
            "prompt, options, correct_option, chosen_option, is_correct, delta, answered_at) "
            "VALUES ('i', 's', 'w', 1, 0, 'cat', '[\"кот\",\"пёс\"]', 0, 0, 1, 4, '2026-01-01')"
        )
    command.upgrade(config, "head")
    with sqlite3.connect(file) as db:
        row = db.execute(
            "SELECT correct_option, chosen_option, is_correct, delta, expected_answers, "
            "submitted_text FROM training_items WHERE id = 'i'"
        ).fetchone()
        assert row == (0, 0, 1, 4, None, None)
        db.execute(
            "INSERT INTO training_items (id, session_id, word_id, word_content_version, "
            "position, prompt, options, correct_option, expected_answers) "
            "VALUES ('input', 's', 'w', 1, 1, 'cat', '[]', NULL, '[\"кот\"]')"
        )
    with pytest.raises(RuntimeError, match="Cannot downgrade"):
        command.downgrade(config, "b24a4bb7ec9e")
    with sqlite3.connect(file) as db:
        assert db.execute("SELECT count(*) FROM training_items").fetchone() == (2,)
