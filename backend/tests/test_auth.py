from collections.abc import Awaitable, Callable

from lexicona.infrastructure.models import User
from tests.conftest import Client


async def test_login_sets_http_only_cookie(
    anon: Client, create_user: Callable[..., Awaitable[User]]
) -> None:
    await create_user("alice")
    response = await anon.post(
        "/api/auth/login", json={"login": "alice", "password": "correct horse battery"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["user"]["login"] == "alice"
    assert body["user"]["difficulty"] == "medium"
    assert body["csrf_token"]
    cookie = response.headers["set-cookie"]
    assert "lexicona_session=" in cookie
    assert "HttpOnly" in cookie
    assert "SameSite=lax" in cookie
    assert response.headers["cache-control"] == "no-store"


async def test_wrong_password_and_unknown_login_look_the_same(
    anon: Client, create_user: Callable[..., Awaitable[User]]
) -> None:
    await create_user("alice")
    wrong = await anon.post("/api/auth/login", json={"login": "alice", "password": "nope"})
    unknown = await anon.post("/api/auth/login", json={"login": "ghost", "password": "nope"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()


async def test_login_is_throttled_after_repeated_failures(
    anon: Client, create_user: Callable[..., Awaitable[User]]
) -> None:
    await create_user("alice")
    for _ in range(10):
        await anon.post("/api/auth/login", json={"login": "alice", "password": "nope"})
    response = await anon.post(
        "/api/auth/login", json={"login": "alice", "password": "correct horse battery"}
    )
    assert response.status_code == 429


async def test_me_requires_session(anon: Client) -> None:
    assert (await anon.get("/api/auth/me")).status_code == 401
    anon.cookies.set("lexicona_session", "forged")
    assert (await anon.get("/api/auth/me")).status_code == 401


async def test_me_returns_same_csrf_token(alice: Client) -> None:
    response = await alice.get("/api/auth/me")
    assert response.json()["csrf_token"] == alice.csrf


async def test_mutation_without_csrf_header_is_rejected(alice: Client) -> None:
    del alice.headers["X-CSRF-Token"]
    response = await alice.post("/api/words", json={"headword": "cat", "translations": ["кот"]})
    assert response.status_code == 403
    alice.headers["X-CSRF-Token"] = "wrong"
    response = await alice.post("/api/words", json={"headword": "cat", "translations": ["кот"]})
    assert response.status_code == 403


async def test_non_ascii_csrf_header_is_rejected(alice: Client) -> None:
    del alice.headers["X-CSRF-Token"]
    response = await alice.post(
        "/api/words",
        json={"headword": "cat", "translations": ["кот"]},
        headers=[(b"X-CSRF-Token", b"\xff")],
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "csrf_failed"
    assert (await alice.get("/api/words")).json() == []


async def test_logout_ends_session(alice: Client) -> None:
    assert (await alice.post("/api/auth/logout")).status_code == 204
    assert (await alice.get("/api/auth/me")).status_code == 401


async def test_update_difficulty(alice: Client) -> None:
    response = await alice.put("/api/auth/settings", json={"difficulty": "very_hard"})
    assert response.json()["difficulty"] == "very_hard"
    assert (await alice.get("/api/auth/me")).json()["user"]["difficulty"] == "very_hard"
    bad = await alice.put("/api/auth/settings", json={"difficulty": "cefr_b2"})
    assert bad.status_code == 422


SPEECH = {
    "en_locale": "en-AU",
    "en_voice_uri": None,
    "ru_voice_uri": "голос",
    "rate": 1,
    "auto_prompt": False,
    "speak_en": True,
    "speak_ru": False,
    "engine_en": "server",
    "engine_ru": "browser",
    # A Piper id saved before Kokoro stays valid, so the speech section is not dropped.
    "server_en_us": "en_US-lessac-high",
    "server_en_gb": None,
    "server_ru": None,
}
TRAINING = {
    "mode": "input",
    "direction": "ru_en",
    "purpose": "scheduled",
    "include_new": False,
    "size": 25,
    "tag_ids": ["b", "a", "a"],
    "progress_min": 0,
    "progress_max": 100,
    "order": "created_asc",
    "shuffle": True,
}


async def test_preferences_merge_per_account(alice: Client, bob: Client, app: object) -> None:
    from fastapi import FastAPI
    from sqlalchemy import update

    from lexicona.infrastructure.models import User

    assert isinstance(app, FastAPI)
    saved = await alice.put("/api/auth/settings", json={"speech": SPEECH})
    assert saved.status_code == 200
    body = saved.json()
    assert body["difficulty"] == "medium"
    assert body["preferences"]["speech"]["en_locale"] == "en-AU"
    assert body["preferences"]["speech"]["rate"] == 1
    assert body["preferences"]["training"] is None
    assert (await bob.get("/api/auth/me")).json()["user"]["preferences"] == {
        "training": None,
        "speech": None,
        "training_auto_advance": False,
    }

    trained = await alice.put("/api/auth/settings", json={"training": TRAINING})
    assert trained.status_code == 200
    prefs = trained.json()["preferences"]
    assert prefs["training"]["tag_ids"] == ["a", "b"]
    assert prefs["training"]["mode"] == "input"
    assert prefs["speech"]["speak_ru"] is False
    assert trained.json()["difficulty"] == "medium"

    leveled = await alice.put("/api/auth/settings", json={"difficulty": "hard"})
    assert leveled.json()["difficulty"] == "hard"
    assert leveled.json()["preferences"]["training"]["size"] == 25
    assert leveled.json()["preferences"]["speech"]["en_locale"] == "en-AU"

    assert (await alice.put("/api/auth/settings", json={})).status_code == 422
    assert (await alice.put("/api/auth/settings", json={"difficulty": None})).status_code == 422
    assert (
        await alice.put("/api/auth/settings", json={"difficulty": "easy", "theme": "dark"})
    ).status_code == 422
    matching = {**TRAINING, "mode": "matching", "direction": "ru_en"}
    assert (await alice.put("/api/auth/settings", json={"training": matching})).status_code == 422
    assert (
        await alice.put("/api/auth/settings", json={"speech": {**SPEECH, "rate": 2}})
    ).status_code == 422
    assert (
        await alice.put("/api/auth/settings", json={"speech": {**SPEECH, "en_voice_uri": ""}})
    ).status_code == 422
    kept = (await alice.get("/api/auth/me")).json()["user"]
    assert kept["difficulty"] == "hard"
    assert kept["preferences"]["training"]["direction"] == "ru_en"
    assert kept["preferences"]["training"]["include_learned"] is False
    assert kept["preferences"]["speech"]["rate"] == 1
    learned = await alice.put(
        "/api/auth/settings", json={"training": {**TRAINING, "include_learned": True}}
    )
    assert learned.status_code == 200
    assert learned.json()["preferences"]["training"]["include_learned"] is True
    assert (
        await alice.put(
            "/api/auth/settings", json={"training": {**TRAINING, "include_learned": "yes"}}
        )
    ).status_code == 422
    assert (await alice.get("/api/auth/me")).json()["user"]["preferences"]["training"][
        "include_learned"
    ] is True

    cleared = await alice.put("/api/auth/settings", json={"training": None})
    assert cleared.status_code == 200
    assert cleared.json()["preferences"]["training"] is None
    assert cleared.json()["preferences"]["speech"]["engine_en"] == "server"

    database = app.state.db
    async with database.sessions() as db:
        await db.execute(
            update(User)
            .where(User.login == "alice")
            .values(preferences={"training": TRAINING, "speech": SPEECH})
        )
        await db.commit()
    legacy = (await alice.get("/api/auth/me")).json()["user"]["preferences"]["training"]
    assert legacy["mode"] == "input" and legacy["include_learned"] is False

    async with database.sessions() as db:
        await db.execute(
            update(User)
            .where(User.login == "alice")
            .values(preferences={"training": {"mode": "nope"}, "speech": SPEECH, "extra": 1})
        )
        await db.commit()
    damaged = await alice.get("/api/auth/me")
    assert damaged.status_code == 200
    assert damaged.json()["user"]["preferences"]["training"] is None
    assert damaged.json()["user"]["preferences"]["speech"]["en_locale"] == "en-AU"
    restored = await alice.put(
        "/api/auth/settings", json={"speech": {**SPEECH, "en_locale": "en-GB"}}
    )
    assert restored.status_code == 200
    assert restored.json()["preferences"]["training"] is None
    assert restored.json()["preferences"]["speech"]["en_locale"] == "en-GB"


async def test_overlapping_preference_writes_keep_both_sections(alice: Client) -> None:
    import asyncio

    from lexicona.interfaces.http.routers import auth as auth_router

    started = asyncio.Event()
    release = asyncio.Event()
    entered = 0

    async def hold() -> None:
        nonlocal entered
        entered += 1
        if entered == 1:
            started.set()
            await release.wait()

    auth_router.preference_write_gate = hold
    try:
        speech_task = asyncio.create_task(alice.put("/api/auth/settings", json={"speech": SPEECH}))
        await asyncio.wait_for(started.wait(), timeout=2)
        trained = await alice.put("/api/auth/settings", json={"training": TRAINING})
        assert trained.status_code == 200
        assert trained.json()["preferences"]["training"]["mode"] == "input"
        assert trained.json()["preferences"]["speech"] is None
        release.set()
        speech = await asyncio.wait_for(speech_task, timeout=2)
    finally:
        release.set()
        auth_router.preference_write_gate = None

    assert speech.status_code == 200
    assert speech.json()["preferences"]["speech"]["en_locale"] == "en-AU"
    assert speech.json()["preferences"]["training"]["tag_ids"] == ["a", "b"]
    assert speech.json()["difficulty"] == "medium"
    saved = (await alice.get("/api/auth/me")).json()["user"]
    assert saved["preferences"]["speech"]["en_locale"] == "en-AU"
    assert saved["preferences"]["training"]["mode"] == "input"
    assert saved["difficulty"] == "medium"


async def test_section_write_keeps_a_concurrent_difficulty(alice: Client) -> None:
    import asyncio

    from lexicona.interfaces.http.routers import auth as auth_router

    started = asyncio.Event()
    release = asyncio.Event()
    entered = 0

    async def hold() -> None:
        nonlocal entered
        entered += 1
        if entered == 1:
            started.set()
            await release.wait()

    auth_router.preference_write_gate = hold
    try:
        speech_task = asyncio.create_task(alice.put("/api/auth/settings", json={"speech": SPEECH}))
        await asyncio.wait_for(started.wait(), timeout=2)
        leveled = await alice.put("/api/auth/settings", json={"difficulty": "hard"})
        assert leveled.status_code == 200
        assert leveled.json()["difficulty"] == "hard"
        release.set()
        speech = await asyncio.wait_for(speech_task, timeout=2)
    finally:
        release.set()
        auth_router.preference_write_gate = None

    assert speech.status_code == 200
    assert speech.json()["difficulty"] == "hard"
    assert speech.json()["preferences"]["speech"]["en_locale"] == "en-AU"
    saved = (await alice.get("/api/auth/me")).json()["user"]
    assert saved["difficulty"] == "hard"
    assert saved["preferences"]["speech"]["en_locale"] == "en-AU"
