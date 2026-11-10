import asyncio
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from alembic import command
from fastapi import FastAPI
from sqlalchemy import select, update

from lexicona.infrastructure.db import Database, utcnow
from lexicona.infrastructure.models import AnswerEvent, TrainingItem, TrainingSession, User
from tests.conftest import Client, add_word
from tests.test_app import alembic_config


def test_migration_preserves_snapshots_and_rejects_destructive_downgrade(tmp_path: Path) -> None:
    file = tmp_path / "resume.db"
    config = alembic_config(f"sqlite+aiosqlite:///{file}")
    command.upgrade(config, "b7d42f0e9a61")
    with sqlite3.connect(file) as db:
        db.execute(
            "INSERT INTO users (id, login, password_hash, is_admin, difficulty, created_at) "
            "VALUES ('u', 'alice', 'hash', 0, 'medium', '2020-01-01')"
        )
        db.execute(
            "INSERT INTO words (id, owner_id, headword, normalized_headword, progress, "
            "content_version, created_at, updated_at) "
            "VALUES ('w', 'u', 'cat', 'cat', 5, 1, '2020-01-01', '2020-01-01')"
        )
        db.execute(
            "INSERT INTO training_sessions (id, owner_id, mode, direction, difficulty, created_at) "
            "VALUES ('s', 'u', 'input', 'en_ru', 'medium', '2020-01-01')"
        )
        db.execute(
            "INSERT INTO training_items (id, session_id, word_id, word_content_version, "
            "position, prompt, options, expected_answers) "
            "VALUES ('i', 's', 'w', 1, 0, 'cat', '[]', '[\"кот\"]')"
        )
    command.upgrade(config, "head")
    with sqlite3.connect(file) as db:
        db.execute("PRAGMA foreign_keys=ON")
        assert db.execute("SELECT status FROM training_sessions WHERE id='s'").fetchone() == (
            "active",
        )
        assert db.execute("SELECT statistics_started_at FROM users WHERE id='u'").fetchone()[0]
        db.execute("DELETE FROM words WHERE id='w'")
        assert db.execute("SELECT word_id, prompt FROM training_items WHERE id='i'").fetchone() == (
            None,
            "cat",
        )
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    with pytest.raises(RuntimeError, match="Cannot downgrade"):
        command.downgrade(config, "b7d42f0e9a61")


async def test_resume_retry_finish_and_owner(app: FastAPI, alice: Client, bob: Client) -> None:
    word = await add_word(alice, "cat", "кот")
    assert (await alice.get("/api/training/sessions/latest")).json() is None
    started = (
        await alice.post("/api/training/sessions", json={"mode": "input", "size": "all"})
    ).json()
    session_id = started["id"]
    item_id = started["items"][0]["id"]
    url = f"/api/training/items/{item_id}/answer"
    first = await alice.post(url, json={"text": "wrong"})
    assert first.status_code == 200 and not first.json()["correct"]
    saved = (await alice.get("/api/training/sessions/latest")).json()
    assert saved["requested_size"] == "all" and saved["status"] == "active"
    item = saved["items"][0]
    assert item["state"] == "retryable" and item["result"]["correct"] is False
    assert "expected_answers" not in item["result"] and "correct_option" not in item["result"]
    assert (await bob.get(f"/api/training/sessions/{session_id}")).status_code == 404
    assert (await bob.post(f"/api/training/sessions/{session_id}/finish")).status_code == 404
    alice.headers.pop("X-CSRF-Token")
    assert (await alice.post(f"/api/training/sessions/{session_id}/finish")).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    assert (await alice.post(url, json={"text": "кот"})).json()["delta"] == 0
    event_db: Database = app.state.db
    async with event_db.sessions() as db:
        events = list(await db.scalars(select(AnswerEvent)))
        assert len(events) == 1 and events[0].correct is False and events[0].word_id == word["id"]
    finish = await alice.post(f"/api/training/sessions/{session_id}/finish")
    assert finish.json() == (await alice.post(f"/api/training/sessions/{session_id}/finish")).json()
    assert (await alice.get("/api/training/sessions/latest")).json()["status"] == "finished"
    assert (await alice.post(url, json={"text": "wrong"})).status_code == 200


async def test_finish_answer_race_is_atomic(app: FastAPI, alice: Client) -> None:
    await add_word(alice, "cat", "кот")
    session = (await alice.post("/api/training/sessions", json={"mode": "input"})).json()
    item_id = session["items"][0]["id"]
    answer, finish = await asyncio.gather(
        alice.post(f"/api/training/items/{item_id}/answer", json={"text": "кот"}),
        alice.post(f"/api/training/sessions/{session['id']}/finish"),
    )
    assert answer.status_code in (200, 409) and finish.status_code == 200
    database: Database = app.state.db
    async with database.sessions() as db:
        events = list(await db.scalars(select(AnswerEvent)))
        assert len(events) == (1 if answer.status_code == 200 else 0)
    assert (await alice.post(f"/api/training/items/{item_id}/skip")).status_code == (
        200 if events else 409
    )


async def test_deleted_word_snapshot_and_history(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот")
    session = (await alice.post("/api/training/sessions", json={"mode": "input"})).json()
    item_id = session["items"][0]["id"]
    await alice.post(f"/api/training/items/{item_id}/answer", json={"text": "wrong"})
    await alice.delete(f"/api/words/{word['id']}")
    snapshot = (await alice.get(f"/api/training/sessions/{session['id']}")).json()
    assert snapshot["items"][0]["result"] == {
        "outcome": "unavailable",
        "reason": "word_deleted",
        "delta": 0,
        "progress": None,
    }
    stats = (await alice.get("/api/statistics")).json()
    assert stats["total_words"] == 0 and stats["total_answers"] == 1


async def test_statistics_moscow_boundaries_and_owner(
    app: FastAPI, alice: Client, bob: Client
) -> None:
    await add_word(alice, "cat", "кот")
    session = (await alice.post("/api/training/sessions", json={"mode": "input"})).json()
    await alice.post(
        f"/api/training/items/{session['items'][0]['id']}/answer", json={"text": "кот"}
    )
    database: Database = app.state.db
    today = (utcnow() + timedelta(hours=3)).date()
    midnight_moscow_utc = datetime.combine(today, datetime.min.time()) - timedelta(hours=3)
    async with database.sessions() as db:
        event = await db.scalar(select(AnswerEvent))
        assert event is not None
        event.created_at = midnight_moscow_utc - timedelta(seconds=1)
        await db.execute(
            update(User)
            .where(User.id == event.owner_id)
            .values(statistics_started_at=midnight_moscow_utc - timedelta(days=1))
        )
        await db.commit()
    result = (await alice.get("/api/statistics", params={"period": "30d"})).json()
    assert (
        len(result["days"]) == 30
        and result["days"][-2]["answers"] == 1
        and result["days"][-1]["answers"] == 0
    )
    assert result["total_answers"] == result["correct_answers"] == 1
    assert result["active_days"] == 1 and result["accuracy_percent"] == 100
    assert (await bob.get("/api/statistics")).json()["total_answers"] == 0
    assert (await alice.get("/api/statistics", params={"period": "year"})).json()[
        "total_words"
    ] == 1


async def test_corrupt_matching_cannot_resume_but_can_finish(app: FastAPI, alice: Client) -> None:
    for en, ru in [("cat", "кот"), ("dog", "собака")]:
        await add_word(alice, en, ru)
    session = (await alice.post("/api/training/sessions", json={"mode": "matching"})).json()
    database: Database = app.state.db
    async with database.sessions() as db:
        item = await db.get(TrainingItem, session["items"][0]["id"])
        assert item is not None
        item.options = ["bad"]
        await db.commit()
    response = await alice.get(f"/api/training/sessions/{session['id']}")
    assert response.status_code == 409 and response.json()["detail"] == "invalid_matching_snapshot"
    latest = await alice.get("/api/training/sessions/latest")
    assert latest.status_code == 200
    assert latest.json()["id"] == session["id"]
    assert (
        latest.json()["resume_error"] == "invalid_matching_snapshot"
        and latest.json()["items"] == []
    )
    assert (await alice.post(f"/api/training/sessions/{session['id']}/finish")).status_code == 200


async def test_matching_resume_eight_and_legacy_four(app: FastAPI, alice: Client) -> None:
    for index in range(9):
        await add_word(alice, f"word{index}", f"перевод{index}")
    session = (
        await alice.post("/api/training/sessions", json={"mode": "matching", "size": "all"})
    ).json()
    snapshot = (await alice.get(f"/api/training/sessions/{session['id']}")).json()
    assert [len(item["options"]) for item in snapshot["items"]] == [8] * 8 + [1]
    database: Database = app.state.db
    async with database.sessions() as db:
        saved = list(
            await db.scalars(
                select(TrainingItem)
                .where(TrainingItem.session_id == session["id"])
                .order_by(TrainingItem.position)
            )
        )
        for offset in (0, 4):
            batch = saved[offset : offset + 4]
            options = [
                item.options[item.correct_option]
                for item in batch
                if item.correct_option is not None
            ]
            for index, item in enumerate(batch):
                item.options = options
                item.correct_option = index
        await db.delete(saved[8])
        await db.commit()
    snapshot = (await alice.get(f"/api/training/sessions/{session['id']}")).json()
    assert [len(item["options"]) for item in snapshot["items"]] == [4] * 8


async def test_latest_tie_does_not_fall_back_to_older_active(app: FastAPI, alice: Client) -> None:
    await add_word(alice, "cat", "кот")
    first = (await alice.post("/api/training/sessions", json={"mode": "input"})).json()
    second = (await alice.post("/api/training/sessions", json={"mode": "input"})).json()
    database: Database = app.state.db
    async with database.sessions() as db:
        await db.execute(
            update(TrainingSession)
            .where(TrainingSession.id.in_([first["id"], second["id"]]))
            .values(created_at=datetime(2026, 1, 1))
        )
        await db.commit()
    latest = max(first["id"], second["id"])
    assert (await alice.post(f"/api/training/sessions/{latest}/finish")).status_code == 200
    saved = (await alice.get("/api/training/sessions/latest")).json()
    assert saved["id"] == latest and saved["status"] == "finished"


async def test_parallel_wrong_answers_record_first_only(app: FastAPI, alice: Client) -> None:
    await add_word(alice, "cat", "кот")
    session = (await alice.post("/api/training/sessions", json={"mode": "input"})).json()
    url = f"/api/training/items/{session['items'][0]['id']}/answer"
    responses = await asyncio.gather(*[alice.post(url, json={"text": "wrong"}) for _ in range(4)])
    assert all(response.status_code == 200 for response in responses)
    assert (await alice.post(url, json={"text": "кот"})).json()["delta"] == 0
    database: Database = app.state.db
    async with database.sessions() as db:
        events = list(await db.scalars(select(AnswerEvent)))
        assert len(events) == 1 and events[0].correct is False
