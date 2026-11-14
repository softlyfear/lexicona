import asyncio
from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy import select

from lexicona.infrastructure.db import Database
from lexicona.infrastructure.models import User
from lexicona.interfaces.http.preferences import public_preferences
from lexicona.interfaces.http.routers import auth as auth_router
from tests.conftest import Client
from tests.test_auth import SPEECH, TRAINING


async def test_auto_advance_default_persistence_owner_and_protections(
    app: FastAPI, alice: Client, bob: Client, anon: Client
) -> None:
    assert (await alice.get("/api/auth/me")).json()["user"]["preferences"][
        "training_auto_advance"
    ] is False
    url = "/api/auth/settings"
    unauthenticated = await anon.put(url, json={"training_auto_advance": True})
    assert unauthenticated.status_code == 401
    assert unauthenticated.headers["cache-control"] == "no-store"
    alice.headers.pop("X-CSRF-Token")
    forbidden = await alice.put(url, json={"training_auto_advance": True})
    assert forbidden.status_code == 403
    assert forbidden.headers["cache-control"] == "no-store"
    alice.headers["X-CSRF-Token"] = alice.csrf
    response = await alice.put(url, json={"training_auto_advance": True})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["preferences"]["training_auto_advance"] is True
    assert response.json()["difficulty"] == "medium"
    assert (await bob.get("/api/auth/me")).json()["user"]["preferences"][
        "training_auto_advance"
    ] is False
    assert (await bob.put(url, json={"training_auto_advance": False})).status_code == 200
    assert (await alice.get("/api/auth/me")).json()["user"]["preferences"][
        "training_auto_advance"
    ] is True
    await alice.post("/api/auth/logout")
    logged_in = await alice.login("alice")
    assert logged_in["user"]["preferences"]["training_auto_advance"] is True
    disabled = await alice.put(url, json={"training_auto_advance": False})
    assert disabled.json()["preferences"]["training_auto_advance"] is False
    database: Database = app.state.db
    async with database.sessions() as db:
        user = await db.scalar(select(User).where(User.login == "alice"))
        assert user is not None
        assert user.preferences == {"training_auto_advance": False}
        assert user.preferences_revision == 2


@pytest.mark.parametrize("invalid", [None, "true", "false", "", 0, 1, 1.0, [], {}])
async def test_auto_advance_write_is_strict(alice: Client, invalid: Any) -> None:
    url = "/api/auth/settings"
    await alice.put(url, json={"training_auto_advance": True})
    response = await alice.put(url, json={"training_auto_advance": invalid, "difficulty": "hard"})
    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"
    saved = (await alice.get("/api/auth/me")).json()["user"]
    assert saved["preferences"]["training_auto_advance"] is True
    assert saved["difficulty"] == "medium"


async def test_independent_flag_survives_sections_and_null_resets(alice: Client) -> None:
    url = "/api/auth/settings"
    await alice.put(url, json={"training_auto_advance": True})
    for change in (
        {"training": TRAINING},
        {"speech": SPEECH},
        {"difficulty": "hard"},
        {"training": None},
        {"speech": None},
        {"training": TRAINING, "speech": SPEECH},
        {"training": None, "speech": None},
    ):
        response = await alice.put(url, json=change)
        assert response.status_code == 200
        assert response.json()["preferences"]["training_auto_advance"] is True
    assert (await alice.put(url, json={})).status_code == 422


@pytest.mark.parametrize("stored", [None, "true", "false", 0, 1, [], {}])
async def test_invalid_stored_flag_falls_back_without_losing_valid_sections(
    app: FastAPI, alice: Client, stored: Any
) -> None:
    database: Database = app.state.db
    async with database.sessions() as db:
        user = await db.scalar(select(User).where(User.login == "alice"))
        assert user is not None
        user.preferences = {"training_auto_advance": stored, "training": TRAINING, "speech": SPEECH}
        await db.commit()
    response = await alice.get("/api/auth/me")
    assert response.status_code == 200
    prefs = response.json()["user"]["preferences"]
    assert prefs["training_auto_advance"] is False
    assert prefs["training"]["mode"] == "input"
    assert prefs["speech"]["en_locale"] == "en-AU"
    repaired = await alice.put("/api/auth/settings", json={"training_auto_advance": True})
    assert repaired.json()["preferences"]["training_auto_advance"] is True
    assert repaired.json()["preferences"]["training"]["mode"] == "input"


@pytest.mark.parametrize("raw", [None, {}, '{"speech": null}', "broken", [], {"other": True}])
def test_old_or_damaged_documents_default_to_off(raw: Any) -> None:
    assert public_preferences(raw).training_auto_advance is False


@pytest.mark.parametrize(
    "section_change",
    [{"training": TRAINING}, {"speech": SPEECH}, {"training": None, "speech": None}],
)
@pytest.mark.parametrize("flag_first", [True, False])
async def test_overlapping_flag_and_section_writes_merge(
    alice: Client, section_change: dict[str, Any], flag_first: bool
) -> None:
    url = "/api/auth/settings"
    await alice.put(url, json={"training": TRAINING, "speech": SPEECH})
    started, release = asyncio.Event(), asyncio.Event()
    entered = 0

    async def hold() -> None:
        nonlocal entered
        entered += 1
        if entered == 1:
            started.set()
            await release.wait()

    flag_change = {"training_auto_advance": True}
    delayed, immediate = (
        (flag_change, section_change) if flag_first else (section_change, flag_change)
    )
    auth_router.preference_write_gate = hold
    task = asyncio.create_task(alice.put(url, json=delayed))
    try:
        await asyncio.wait_for(started.wait(), timeout=2)
        response = await alice.put(url, json=immediate)
        assert response.status_code == 200
        release.set()
        completed = await asyncio.wait_for(task, timeout=2)
        assert completed.status_code == 200
    finally:
        release.set()
        auth_router.preference_write_gate = None
        await asyncio.gather(task, return_exceptions=True)
    assert entered >= 3  # The delayed save must retry against the newer revision.
    prefs = (await alice.get("/api/auth/me")).json()["user"]["preferences"]
    assert prefs["training_auto_advance"] is True
    for section in ("training", "speech"):
        if section in section_change and section_change[section] is None:
            assert prefs[section] is None
        else:
            assert prefs[section] is not None
    assert completed.json()["preferences"] == prefs
