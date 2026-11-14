from datetime import timedelta
from typing import Any, cast

import pytest
from fastapi import FastAPI
from sqlalchemy import delete, select

from lexicona.infrastructure.db import Database
from lexicona.infrastructure.models import AnswerEvent, TrainingItem
from tests.conftest import Client, add_word


async def start(alice: Client, mode: str = "input") -> dict[str, Any]:
    response = await alice.post(
        "/api/training/sessions", json={"mode": mode, "size": "all", "order": "created_asc"}
    )
    assert response.status_code == 201
    return cast(dict[str, Any], response.json())


@pytest.mark.parametrize("mode", ["input", "choice", "matching"])
@pytest.mark.parametrize("ending", ["answer", "reveal", "skip"])
async def test_first_error_survives_completion_replay_resume(
    app: FastAPI, alice: Client, mode: str, ending: str
) -> None:
    await add_word(alice, "cat", "кот")
    if mode == "matching":
        await add_word(alice, "dog", "собака")
    session = await start(alice, mode)
    item_id = session["items"][0]["id"]
    database: Database = app.state.db
    async with database.sessions() as db:
        item = await db.get(TrainingItem, item_id)
        assert item is not None
        right = {"text": "кот"} if mode == "input" else {"option": item.correct_option}
        wrong = (
            {"text": "wrong"}
            if mode == "input"
            else {"option": (int(item.correct_option or 0) + 1) % len(item.options)}
        )
    url = f"/api/training/items/{item_id}"
    assert (await alice.post(f"{url}/answer", json=wrong)).json()["correct"] is False
    summary_url = f"/api/training/sessions/{session['id']}/summary"
    first = (await alice.get(summary_url)).json()
    assert first["first_attempt"]["incorrect"] == 1
    assert first["completion"]["pending"] == len(session["items"])
    assert (await alice.get("/api/training/sessions/latest")).json()["items"][0][
        "state"
    ] == "retryable"
    finished = await alice.post(f"{url}/{ending}", json=right if ending == "answer" else None)
    assert finished.status_code == 200
    result = (await alice.get(summary_url)).json()
    assert result["first_attempt"] == first["first_attempt"]
    category = {"answer": "answered", "reveal": "assisted", "skip": "skipped"}[ending]
    assert result["completion"][category] == 1
    assert result["completion"]["pending"] == len(session["items"]) - 1
    assert result["first_attempt"]["accuracy_percent"] == 0
    assert (await alice.post(f"{url}/answer", json=right)).json()["delta"] == 0
    assert (await alice.post(f"{url}/skip")).status_code == 200
    assert (await alice.get(summary_url)).json() == result
    assert (await alice.post(f"/api/training/sessions/{session['id']}/finish")).status_code == 200
    assert (await alice.get(summary_url)).json() == result
    async with database.sessions() as db:
        events = list(await db.scalars(select(AnswerEvent)))
        assert len(events) == 1 and events[0].correct is False
    stats = (await alice.get("/api/statistics")).json()
    assert stats["total_answers"] == 1 and stats["correct_answers"] == 0


async def test_summary_owner_read_only_no_store_and_secrecy(alice: Client, bob: Client) -> None:
    await add_word(alice, "cat", "кот")
    session = await start(alice)
    url = f"/api/training/sessions/{session['id']}/summary"
    alice.headers.pop("X-CSRF-Token")
    response = await alice.get(url)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "id": session["id"],
        "total": 1,
        "completion": {"answered": 0, "assisted": 0, "skipped": 0, "unavailable": 0, "pending": 1},
        "first_attempt": {
            "correct": 0,
            "incorrect": 0,
            "unknown": 0,
            "not_attempted": 1,
            "not_applicable": 0,
            "accuracy_percent": None,
        },
    }
    assert (await bob.get(url)).status_code == 404
    assert (await bob.get(url)).headers["cache-control"] == "no-store"
    assert (await alice.get("/api/training/sessions/missing/summary")).status_code == 404
    assert (
        await alice.post(f"/api/training/items/{session['items'][0]['id']}/skip")
    ).status_code == 403


@pytest.mark.parametrize("ending", ["reveal", "skip"])
async def test_no_attempt_completion_is_not_an_error(alice: Client, ending: str) -> None:
    await add_word(alice, "cat", "кот")
    session = await start(alice)
    await alice.post(f"/api/training/items/{session['items'][0]['id']}/{ending}")
    result = (await alice.get(f"/api/training/sessions/{session['id']}/summary")).json()
    assert result["first_attempt"]["not_attempted"] == 1
    assert result["first_attempt"]["incorrect"] == 0
    assert result["first_attempt"]["accuracy_percent"] is None


@pytest.mark.parametrize("ending", ["answer", "reveal", "skip"])
async def test_missing_historical_event_is_unknown_not_terminal_accuracy(
    app: FastAPI, alice: Client, ending: str
) -> None:
    await add_word(alice, "cat", "кот")
    session = await start(alice)
    url = f"/api/training/items/{session['items'][0]['id']}"
    await alice.post(f"{url}/answer", json={"text": "wrong"})
    await alice.post(f"{url}/{ending}", json={"text": "кот"} if ending == "answer" else None)
    database: Database = app.state.db
    async with database.sessions() as db:
        await db.execute(delete(AnswerEvent))
        await db.commit()
    result = (await alice.get(f"/api/training/sessions/{session['id']}/summary")).json()
    category = {"answer": "answered", "reveal": "assisted", "skip": "skipped"}[ending]
    assert result["completion"][category] == 1
    assert result["first_attempt"]["unknown"] == 1
    assert result["first_attempt"]["correct"] == 0
    assert result["first_attempt"]["accuracy_percent"] is None


async def test_pre_history_completion_is_unknown_and_cards_not_objective(
    app: FastAPI, alice: Client
) -> None:
    await add_word(alice, "cat", "кот")
    session = await start(alice)
    await alice.post(f"/api/training/items/{session['items'][0]['id']}/skip")
    database: Database = app.state.db
    async with database.sessions() as db:
        item = await db.get(TrainingItem, session["items"][0]["id"])
        assert item is not None
        item.session.created_at -= timedelta(days=1)
        await db.commit()
    summary_url = f"/api/training/sessions/{session['id']}/summary"
    first = (await alice.get(summary_url)).json()["first_attempt"]
    assert first["unknown"] == 1 and first["not_attempted"] == 0
    async with database.sessions() as db:
        item = await db.get(TrainingItem, session["items"][0]["id"])
        assert item is not None
        item.session.mode = "cards"
        await db.commit()
    first = (await alice.get(summary_url)).json()["first_attempt"]
    assert first["not_applicable"] == 1 and first["unknown"] == 0


async def test_hint_before_first_submission_and_deleted_word_history(alice: Client) -> None:
    word = await add_word(alice, "cat", "кот")
    session = await start(alice)
    url = f"/api/training/items/{session['items'][0]['id']}"
    await alice.post(f"{url}/hint", json={"text": ""})
    assert (await alice.post(f"{url}/answer", json={"text": "кот"})).json()["delta"] == 4
    summary_url = f"/api/training/sessions/{session['id']}/summary"
    summary = (await alice.get(summary_url)).json()
    assert summary["first_attempt"]["correct"] == 1
    assert summary["first_attempt"]["accuracy_percent"] == 100
    await alice.delete(f"/api/words/{word['id']}")
    assert (await alice.get(summary_url)).json() == summary
