import asyncio
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from fastapi import FastAPI
from sqlalchemy import select, update

from lexicona.db import Database, utcnow
from lexicona.models import TrainingItem, Word, WordProgress
from lexicona.routers import training
from lexicona.srs import Grade, review
from tests.conftest import Client, add_legacy_card_item, add_word
from tests.test_app import alembic_config


async def start(client: Client, **body: Any) -> dict[str, Any]:
    response = await client.post("/api/training/sessions", json=body)
    assert response.status_code == 201, response.text
    return response.json()  # type: ignore[no-any-return]


async def get_progress(app: FastAPI, word_id: str) -> WordProgress:
    database: Database = app.state.db
    async with database.sessions() as db:
        schedule = await db.scalar(select(WordProgress).where(WordProgress.word_id == word_id))
        assert schedule is not None
        return schedule


async def set_progress_state(app: FastAPI, word_id: str, **values: Any) -> None:
    database: Database = app.state.db
    async with database.sessions() as db:
        await db.execute(
            update(WordProgress).where(WordProgress.word_id == word_id).values(**values)
        )
        await db.commit()


def progress_tuple(schedule: WordProgress) -> tuple[Any, ...]:
    return (
        schedule.stage,
        schedule.has_review,
        schedule.due_at,
        schedule.last_review_at,
        schedule.success_streak,
        schedule.review_count,
        schedule.lapse_count,
        schedule.progress_version,
    )


@pytest.mark.parametrize(
    ("stage", "streak", "grade", "new_stage", "interval", "new_streak", "lapse"),
    [
        (4, 3, "again", 0, timedelta(minutes=10), 0, True),
        (4, 3, "hard", 4, timedelta(days=1), 0, False),
        (0, 3, "good", 1, timedelta(days=1), 4, False),
        (1, 0, "good", 2, timedelta(days=3), 1, False),
        (2, 1, "good", 3, timedelta(days=7), 2, False),
        (3, 1, "good", 4, timedelta(days=14), 2, False),
        (4, 1, "good", 5, timedelta(days=30), 2, False),
        (5, 1, "good", 6, timedelta(days=60), 2, False),
        (6, 5, "good", 6, timedelta(days=60), 6, False),
        (2, 4, "easy", 4, timedelta(days=14), 5, False),
        (5, 4, "easy", 6, timedelta(days=60), 5, False),
        (6, 4, "easy", 6, timedelta(days=60), 5, False),
    ],
)
def test_review_table(
    stage: int,
    streak: int,
    grade: Grade,
    new_stage: int,
    interval: timedelta,
    new_streak: int,
    lapse: bool,
) -> None:
    now = datetime(2026, 1, 2, 3, 4, 5)
    assert review(stage, streak, grade, now) == review(stage, streak, grade, now)
    transition = review(stage, streak, grade, now)
    assert transition.stage == new_stage
    assert transition.due_at == now + interval
    assert transition.success_streak == new_streak
    assert transition.is_lapse is lapse


async def test_scheduled_queue_due_then_at_most_ten_new(
    app: FastAPI, alice: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    words = {
        name: await add_word(alice, name, f"перевод-{name}")
        for name in ["due1", "due2", "future", *[f"new{i}" for i in range(12)]]
    }
    now = utcnow()
    for name in ["due1", "due2"]:
        await set_progress_state(
            app,
            words[name]["id"],
            has_review=True,
            stage=2,
            due_at=now - timedelta(minutes=1),
        )
    await set_progress_state(
        app, words["future"]["id"], has_review=True, stage=3, due_at=now + timedelta(days=1)
    )
    monkeypatch.setattr(training._rng, "sample", lambda population, k: list(population))

    session = await start(alice, mode="input", purpose="scheduled", size="all")
    assert session["purpose"] == "scheduled"
    prompts = [item["prompt"] for item in session["items"]]
    assert len(prompts) == 12
    assert set(prompts[:2]) == {"due1", "due2"}
    assert len(set(prompts[2:])) == 10
    assert set(prompts[2:]) <= {f"new{i}" for i in range(12)}
    assert "future" not in prompts

    due_only = await start(alice, mode="input", purpose="scheduled", include_new=False, size="all")
    assert {item["prompt"] for item in due_only["items"]} == {"due1", "due2"}
    limited = await start(alice, mode="input", purpose="scheduled", size=1)
    assert limited["items"][0]["prompt"] in {"due1", "due2"}


async def test_scheduled_empty_and_free_selection_contract(alice: Client) -> None:
    word = await add_word(alice, "word", "слово")
    response = await alice.post(
        "/api/training/sessions",
        json={"mode": "input", "purpose": "scheduled", "include_new": False},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "no_scheduled_words"
    assert response.headers["cache-control"] == "no-store"

    response = await alice.post("/api/training/sessions", json={"mode": "input"})
    assert response.status_code == 201
    assert response.json()["purpose"] == "free"
    assert response.json()["items"][0]["prompt"] == "word"
    for invalid in [1, 0, "true", None]:
        response = await alice.post(
            "/api/training/sessions", json={"mode": "input", "include_new": invalid}
        )
        assert response.status_code == 422
    assert (await alice.get(f"/api/words/{word['id']}")).status_code == 200


@pytest.mark.parametrize(
    ("grade", "stage", "interval", "streak", "lapses", "delta", "visible"),
    [
        ("again", 0, timedelta(minutes=10), 0, 3, -4, 46),
        ("hard", 2, timedelta(days=1), 0, 2, 0, 50),
        ("good", 3, timedelta(days=7), 5, 2, 4, 54),
        ("easy", 4, timedelta(days=14), 5, 2, 4, 54),
    ],
)
async def test_scheduled_card_grades_update_srs_and_visible_progress(
    app: FastAPI,
    alice: Client,
    grade: Grade,
    stage: int,
    interval: timedelta,
    streak: int,
    lapses: int,
    delta: int,
    visible: int,
) -> None:
    word = await add_word(alice, "cat", "кот")
    await set_progress_state(
        app,
        word["id"],
        stage=2,
        has_review=True,
        due_at=utcnow() - timedelta(days=1),
        success_streak=4,
        review_count=7,
        lapse_count=2,
    )
    database: Database = app.state.db
    async with database.sessions() as db:
        await db.execute(update(Word).where(Word.id == word["id"]).values(progress=50))
        await db.commit()
    before_reveal = progress_tuple(await get_progress(app, word["id"]))
    item = await add_legacy_card_item(app, alice, word["id"], purpose="scheduled")
    await alice.post(f"/api/training/items/{item['id']}/reveal")
    assert progress_tuple(await get_progress(app, word["id"])) == before_reveal
    response = await alice.post(f"/api/training/items/{item['id']}/answer", json={"grade": grade})
    assert response.status_code == 200
    assert response.json()["delta"] == delta
    assert response.json()["progress"] == visible
    schedule = await get_progress(app, word["id"])
    assert schedule.stage == stage
    assert schedule.has_review is True
    assert schedule.last_review_at is not None and schedule.due_at is not None
    assert schedule.due_at - schedule.last_review_at == interval
    assert schedule.success_streak == streak
    assert schedule.review_count == 8
    assert schedule.lapse_count == lapses
    assert schedule.progress_version == 2


@pytest.mark.parametrize(
    ("answer", "correct", "stage", "lapses"), [("кот", True, 2, 0), ("x", False, 0, 1)]
)
async def test_objective_scheduled_answers_map_to_good_or_again(
    app: FastAPI, alice: Client, answer: str, correct: bool, stage: int, lapses: int
) -> None:
    word = await add_word(alice, "cat", "кот")
    await set_progress_state(app, word["id"], stage=1)
    session = await start(alice, mode="input", purpose="scheduled", size=1)
    response = await alice.post(
        f"/api/training/items/{session['items'][0]['id']}/answer", json={"text": answer}
    )
    assert response.status_code == 200 and response.json()["correct"] is correct
    schedule = await get_progress(app, word["id"])
    assert (schedule.stage, schedule.review_count, schedule.lapse_count) == (stage, 1, lapses)
    database: Database = app.state.db
    async with database.sessions() as db:
        item = await db.get(TrainingItem, session["items"][0]["id"])
        assert item is not None and item.grade == ("good" if correct else "again")


async def test_scheduled_retry_does_not_change_progress_or_schedule_twice(
    app: FastAPI, alice: Client
) -> None:
    word = await add_word(alice, "cat", "кот")
    item = (await start(alice, mode="input", purpose="scheduled", size=1))["items"][0]
    url = f"/api/training/items/{item['id']}/answer"
    first = await alice.post(url, json={"text": "ошибка"})
    assert first.json()["delta"] == -4
    before = progress_tuple(await get_progress(app, word["id"]))
    retry = await alice.post(url, json={"text": "другая ошибка"})
    final = await alice.post(url, json={"text": "кот"})
    assert retry.json()["delta"] == final.json()["delta"] == 0
    assert final.json()["correct"] is True
    assert progress_tuple(await get_progress(app, word["id"])) == before
    assert before[5] == 1


async def test_free_practice_and_replay_never_change_schedule(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот")
    due = utcnow() + timedelta(days=5)
    last = utcnow() - timedelta(days=1)
    await set_progress_state(
        app,
        word["id"],
        stage=4,
        has_review=True,
        due_at=due,
        last_review_at=last,
        success_streak=3,
        review_count=8,
        lapse_count=2,
    )
    before = progress_tuple(await get_progress(app, word["id"]))
    item = (await start(alice, mode="input", size=1))["items"][0]
    url = f"/api/training/items/{item['id']}/answer"
    first = await alice.post(url, json={"text": "кот"})
    replay = await alice.post(url, json={"text": "ошибка"})
    assert first.status_code == 200 and first.json()["progress"] == 8
    assert replay.json() == first.json()
    after = progress_tuple(await get_progress(app, word["id"]))
    assert after[:-1] == before[:-1]
    assert after[-1] == before[-1] + 1


@pytest.mark.parametrize("action", ["reveal", "skip"])
async def test_scheduled_assist_and_skip_have_no_srs_effect(
    app: FastAPI, alice: Client, action: str
) -> None:
    word = await add_word(alice, "cat", "кот")
    item = (await start(alice, mode="input", purpose="scheduled", size=1))["items"][0]
    before = progress_tuple(await get_progress(app, word["id"]))
    response = await alice.post(f"/api/training/items/{item['id']}/{action}")
    assert response.status_code == 200 and response.json()["delta"] == 0
    assert progress_tuple(await get_progress(app, word["id"])) == before


async def test_unavailable_and_stale_content_do_not_touch_srs(app: FastAPI, alice: Client) -> None:
    excluded = await add_word(alice, "dog", "собака")
    old_item = (await start(alice, mode="input", purpose="scheduled", size=1))["items"][0]
    await alice.patch(f"/api/words/{excluded['id']}/training", json={"is_excluded": True})
    before = progress_tuple(await get_progress(app, excluded["id"]))
    response = await alice.post(
        f"/api/training/items/{old_item['id']}/answer", json={"text": "собака"}
    )
    assert response.status_code == 200 and response.json()["outcome"] == "unavailable"
    assert progress_tuple(await get_progress(app, excluded["id"])) == before

    edited = await add_word(alice, "cat", "кот")
    stale_item = (await start(alice, mode="input", purpose="scheduled", size=1))["items"][0]
    await alice.put(
        f"/api/words/{edited['id']}", json={"headword": "cat", "translations": ["кошка"]}
    )
    before = progress_tuple(await get_progress(app, edited["id"]))
    response = await alice.post(
        f"/api/training/items/{stale_item['id']}/answer", json={"text": "кот"}
    )
    assert response.status_code == 200
    assert response.json()["outcome"] == "answered" and response.json()["delta"] == 0
    assert progress_tuple(await get_progress(app, edited["id"])) == before


async def test_semantic_reset_is_monotonic_but_cosmetic_tags_and_exclusion_are_not(
    app: FastAPI, alice: Client
) -> None:
    word = await add_word(alice, "cat", "кот")
    due = utcnow() + timedelta(days=3)
    await set_progress_state(
        app,
        word["id"],
        stage=5,
        has_review=True,
        due_at=due,
        last_review_at=utcnow(),
        success_streak=4,
        review_count=9,
        lapse_count=2,
        progress_version=7,
    )
    before = progress_tuple(await get_progress(app, word["id"]))
    response = await alice.put(
        f"/api/words/{word['id']}",
        json={"headword": "Cat", "translations": ["Кот"], "note": "pet", "tags": ["animal"]},
    )
    assert response.status_code == 200
    assert progress_tuple(await get_progress(app, word["id"])) == before
    await alice.patch(f"/api/words/{word['id']}/training", json={"is_excluded": True})
    assert progress_tuple(await get_progress(app, word["id"])) == before

    await alice.put(f"/api/words/{word['id']}", json={"headword": "cat", "translations": ["кошка"]})
    reset = await get_progress(app, word["id"])
    assert progress_tuple(reset) == (0, False, None, None, 0, 0, 0, 8)
    await set_progress_state(app, word["id"], stage=3, has_review=True, review_count=4)
    await alice.put(f"/api/words/{word['id']}", json={"headword": "cat", "translations": ["кот"]})
    assert progress_tuple(await get_progress(app, word["id"])) == (0, False, None, None, 0, 0, 0, 9)


async def test_stale_other_session_gets_409_without_any_mutation(
    app: FastAPI, alice: Client, bob: Client
) -> None:
    word = await add_word(alice, "cat", "кот")
    first = (await start(alice, mode="input", purpose="scheduled", size=1))["items"][0]
    stale = (await start(alice, mode="input", purpose="scheduled", size=1))["items"][0]
    stale_url = f"/api/training/items/{stale['id']}/answer"
    response = await bob.post(stale_url, json={"text": "кот"})
    assert response.status_code == 404 and response.headers["cache-control"] == "no-store"
    alice.headers.pop("X-CSRF-Token")
    response = await alice.post(stale_url, json={"text": "кот"})
    assert response.status_code == 403 and response.headers["cache-control"] == "no-store"
    alice.headers["X-CSRF-Token"] = alice.csrf

    response = await alice.post(f"/api/training/items/{first['id']}/answer", json={"text": "кот"})
    assert response.status_code == 200 and response.json()["progress"] == 8
    before = progress_tuple(await get_progress(app, word["id"]))
    response = await alice.post(stale_url, json={"text": "кот"})
    assert response.status_code == 409
    assert response.json()["detail"] == "PROGRESS_CHANGED"
    assert response.headers["cache-control"] == "no-store"
    assert progress_tuple(await get_progress(app, word["id"])) == before
    assert (await alice.get(f"/api/words/{word['id']}")).json()["progress"] == 8
    database: Database = app.state.db
    async with database.sessions() as db:
        item = await db.get(TrainingItem, stale["id"])
        assert item is not None
        assert item.outcome is None and item.answered_at is None and item.delta is None


async def test_concurrent_sessions_have_one_winner_and_one_progress_conflict(
    app: FastAPI, alice: Client
) -> None:
    word = await add_word(alice, "cat", "кот")
    first = (await start(alice, mode="input", purpose="scheduled", size=1))["items"][0]
    second = (await start(alice, mode="input", purpose="scheduled", size=1))["items"][0]
    responses = await asyncio.gather(
        alice.post(f"/api/training/items/{first['id']}/answer", json={"text": "кот"}),
        alice.post(f"/api/training/items/{second['id']}/answer", json={"text": "кот"}),
    )
    assert sorted(response.status_code for response in responses) == [200, 409]
    conflict = next(response for response in responses if response.status_code == 409)
    assert conflict.json()["detail"] == "PROGRESS_CHANGED"
    schedule = await get_progress(app, word["id"])
    assert schedule.review_count == 1 and schedule.progress_version == 2
    assert (await alice.get(f"/api/words/{word['id']}")).json()["progress"] == 8


def test_srs_migration_backfills_and_enforces_owner_composite_fk(tmp_path: Path) -> None:
    path = tmp_path / "srs.db"
    config = alembic_config(f"sqlite+aiosqlite:///{path}")
    command.upgrade(config, "c83917f0d52a")
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA foreign_keys=ON")
        for user in ["u1", "u2"]:
            db.execute(
                "INSERT INTO users (id, login, password_hash, is_admin, difficulty, created_at) "
                "VALUES (?, ?, 'hash', 0, 'medium', '2026-01-01')",
                (user, user),
            )
        db.execute(
            "INSERT INTO words (id, owner_id, headword, normalized_headword, progress, "
            "is_excluded, training_version, content_version, created_at, updated_at) "
            "VALUES ('w', 'u1', 'cat', 'cat', 123, 0, 1, 1, '2026-01-01', '2026-01-01')"
        )
        db.execute(
            "INSERT INTO training_sessions (id, owner_id, mode, direction, difficulty, created_at) "
            "VALUES ('s', 'u1', 'input', 'en_ru', 'medium', '2026-01-01')"
        )
        db.execute(
            "INSERT INTO training_items (id, session_id, word_id, word_content_version, "
            "word_training_version, position, prompt, options) "
            "VALUES ('i', 's', 'w', 1, 1, 0, 'cat', '[]')"
        )
    command.upgrade(config, "head")
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA foreign_keys=ON")
        assert db.execute(
            "SELECT owner_id, word_id, stage, has_review, due_at, last_review_at, "
            "success_streak, review_count, lapse_count, progress_version FROM word_progress"
        ).fetchall() == [("u1", "w", 0, 0, None, None, 0, 0, 0, 1)]
        assert db.execute("SELECT progress FROM words").fetchone() == (123,)
        assert db.execute("SELECT purpose FROM training_sessions").fetchone() == ("free",)
        assert db.execute("SELECT word_progress_version FROM training_items").fetchone() == (1,)
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO word_progress VALUES ('u2', 'w', 0, 0, NULL, NULL, 0, 0, 0, 1)")
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    command.downgrade(config, "c83917f0d52a")
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT progress FROM words").fetchone() == (123,)
        assert db.execute(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'word_progress'"
        ).fetchone() == (0,)


def test_srs_downgrade_refuses_to_discard_schedule(tmp_path: Path) -> None:
    path = tmp_path / "srs-downgrade.db"
    config = alembic_config(f"sqlite+aiosqlite:///{path}")
    command.upgrade(config, "head")
    with sqlite3.connect(path) as db:
        db.execute(
            "INSERT INTO users (id, login, password_hash, is_admin, difficulty, created_at) "
            "VALUES ('u', 'alice', 'hash', 0, 'medium', '2026-01-01')"
        )
        db.execute(
            "INSERT INTO training_sessions (id, owner_id, mode, direction, purpose, difficulty, "
            "created_at) VALUES ('s', 'u', 'input', 'en_ru', 'scheduled', 'medium', '2026-01-01')"
        )
    with pytest.raises(RuntimeError, match="Cannot downgrade"):
        command.downgrade(config, "c83917f0d52a")
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT purpose FROM training_sessions").fetchone() == ("scheduled",)
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
