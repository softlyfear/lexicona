from collections.abc import Awaitable, Callable

from lexicona.models import User
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


async def test_logout_ends_session(alice: Client) -> None:
    assert (await alice.post("/api/auth/logout")).status_code == 204
    assert (await alice.get("/api/auth/me")).status_code == 401


async def test_update_difficulty(alice: Client) -> None:
    response = await alice.put("/api/auth/settings", json={"difficulty": "very_hard"})
    assert response.json()["difficulty"] == "very_hard"
    assert (await alice.get("/api/auth/me")).json()["user"]["difficulty"] == "very_hard"
    bad = await alice.put("/api/auth/settings", json={"difficulty": "cefr_b2"})
    assert bad.status_code == 422
