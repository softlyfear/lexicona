from datetime import datetime, timedelta

from fastapi import FastAPI
from sqlalchemy import update

from lexicona.infrastructure.db import Database, utcnow
from lexicona.infrastructure.models import Word
from tests.conftest import Client, add_word
from tests.test_srs import set_progress_state
from tests.test_words import set_progress


async def _created_at(app: FastAPI, word_id: str, when: datetime) -> None:
    database: Database = app.state.db
    async with database.sessions() as db:
        await db.execute(update(Word).where(Word.id == word_id).values(created_at=when))
        await db.commit()


def _prompts(body: dict[str, object]) -> list[str]:
    items = body["items"]
    assert isinstance(items, list)
    return [str(item["prompt"]) for item in items]


async def test_word_order_selects_and_sequences_the_pool(
    app: FastAPI, alice: Client, bob: Client
) -> None:
    base = datetime(2026, 1, 1, 12)
    early = await add_word(alice, "early", "раннее")
    middle = await add_word(alice, "middle", "среднее")
    late = await add_word(alice, "late", "позднее")
    foreign = await add_word(bob, "foreign", "чужое")
    await _created_at(app, early["id"], base)
    await _created_at(app, middle["id"], base + timedelta(days=1))
    await _created_at(app, late["id"], base + timedelta(days=2))
    await set_progress(app, early["id"], 20)
    await set_progress(app, middle["id"], 5)
    await set_progress(app, late["id"], 50)
    await set_progress(app, foreign["id"], 0)
    await set_progress_state(app, early["id"], last_review_at=base + timedelta(days=10))
    await set_progress_state(app, middle["id"], last_review_at=base + timedelta(days=1))

    expected = {
        "created_asc": ["early", "middle", "late"],
        "created_desc": ["late", "middle", "early"],
        "progress_asc": ["middle", "early", "late"],
        "progress_desc": ["late", "early", "middle"],
        "reviewed_desc": ["early", "middle", "late"],
        "reviewed_asc": ["middle", "early", "late"],
    }
    for order, prompts in expected.items():
        response = await alice.post(
            "/api/training/sessions",
            json={"mode": "input", "size": "all", "order": order},
        )
        assert response.status_code == 201, response.text
        assert _prompts(response.json()) == prompts

    limited = await alice.post(
        "/api/training/sessions",
        json={"mode": "input", "size": 2, "order": "progress_asc"},
    )
    assert _prompts(limited.json()) == ["middle", "early"]
    assert (await alice.post("/api/training/sessions", json={"order": "newest"})).status_code == 422


async def test_scheduled_order_stays_inside_due_and_new_groups(app: FastAPI, alice: Client) -> None:
    now = utcnow()
    low = await add_word(alice, "low", "низкое")
    high = await add_word(alice, "high", "высокое")
    fresh = await add_word(alice, "fresh", "новое")
    waiting = await add_word(alice, "waiting", "ждущее")
    await set_progress(app, low["id"], 10)
    await set_progress(app, high["id"], 80)
    await set_progress(app, fresh["id"], 0)
    await set_progress(app, waiting["id"], 1)
    await set_progress_state(
        app,
        low["id"],
        has_review=True,
        due_at=now - timedelta(days=1),
        last_review_at=now - timedelta(days=3),
    )
    await set_progress_state(
        app,
        high["id"],
        has_review=True,
        due_at=now - timedelta(hours=1),
        last_review_at=now - timedelta(days=1),
    )
    await set_progress_state(
        app,
        waiting["id"],
        has_review=True,
        due_at=now + timedelta(days=2),
        last_review_at=now,
    )

    response = await alice.post(
        "/api/training/sessions",
        json={
            "mode": "input",
            "purpose": "scheduled",
            "size": "all",
            "order": "progress_asc",
            "include_new": True,
        },
    )
    assert response.status_code == 201, response.text
    assert _prompts(response.json()) == ["low", "high", "fresh"]


async def test_shuffle_randomizes_only_the_selected_prefix(app: FastAPI, alice: Client) -> None:
    base = datetime(2026, 1, 1, 12)
    early = await add_word(alice, "early", "раннее")
    middle = await add_word(alice, "middle", "среднее")
    late = await add_word(alice, "late", "позднее")
    await _created_at(app, early["id"], base)
    await _created_at(app, middle["id"], base + timedelta(days=1))
    await _created_at(app, late["id"], base + timedelta(days=2))
    await set_progress(app, early["id"], 20)
    await set_progress(app, middle["id"], 5)
    await set_progress(app, late["id"], 50)

    seen: set[tuple[str, ...]] = set()
    for _ in range(24):
        response = await alice.post(
            "/api/training/sessions",
            json={"mode": "input", "size": 2, "order": "progress_desc", "shuffle": True},
        )
        assert response.status_code == 201, response.text
        prompts = tuple(_prompts(response.json()))
        assert prompts in {("late", "early"), ("early", "late")}
        seen.add(prompts)
        if len(seen) == 2:
            break
    assert seen == {("late", "early"), ("early", "late")}
    assert (await alice.post("/api/training/sessions", json={"shuffle": "yes"})).status_code == 422


async def test_scheduled_shuffle_stays_inside_due_and_new_groups(
    app: FastAPI, alice: Client
) -> None:
    now = utcnow()
    low = await add_word(alice, "low", "низкое")
    high = await add_word(alice, "high", "высокое")
    fresh = await add_word(alice, "fresh", "новое")
    await set_progress(app, low["id"], 10)
    await set_progress(app, high["id"], 80)
    await set_progress(app, fresh["id"], 0)
    await set_progress_state(
        app,
        low["id"],
        has_review=True,
        due_at=now - timedelta(days=1),
        last_review_at=now - timedelta(days=3),
    )
    await set_progress_state(
        app,
        high["id"],
        has_review=True,
        due_at=now - timedelta(hours=1),
        last_review_at=now - timedelta(days=1),
    )

    seen: set[tuple[str, ...]] = set()
    for _ in range(24):
        response = await alice.post(
            "/api/training/sessions",
            json={
                "mode": "input",
                "purpose": "scheduled",
                "size": "all",
                "order": "progress_asc",
                "include_new": True,
                "shuffle": True,
            },
        )
        assert response.status_code == 201, response.text
        prompts = _prompts(response.json())
        assert prompts[2:] == ["fresh"]
        assert set(prompts[:2]) == {"low", "high"}
        seen.add(tuple(prompts[:2]))
        if len(seen) == 2:
            break
    assert seen == {("low", "high"), ("high", "low")}
