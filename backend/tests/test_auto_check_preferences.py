from typing import Any

import pytest
from fastapi import FastAPI

from lexicona.interfaces.http.preferences import public_preferences
from tests.conftest import Client


async def test_auto_check_default_persistence_and_isolation(
    app: FastAPI, alice: Client, bob: Client, anon: Client
) -> None:
    url = "/api/auth/settings"
    assert (await alice.get("/api/auth/me")).json()["user"]["preferences"][
        "training_auto_check"
    ] is False
    assert (await anon.put(url, json={"training_auto_check": True})).status_code == 401
    alice.headers.pop("X-CSRF-Token")
    assert (await alice.put(url, json={"training_auto_check": True})).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    response = await alice.put(url, json={"training_auto_check": True})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["preferences"]["training_auto_check"] is True
    assert response.json()["preferences"]["training_auto_advance"] is False
    assert (await bob.get("/api/auth/me")).json()["user"]["preferences"][
        "training_auto_check"
    ] is False
    await alice.post("/api/auth/logout")
    logged_in = await alice.login("alice")
    assert logged_in["user"]["preferences"]["training_auto_check"] is True
    disabled = await alice.put(url, json={"training_auto_check": False})
    assert disabled.json()["preferences"]["training_auto_check"] is False


async def test_auto_check_and_auto_advance_are_independent(alice: Client) -> None:
    url = "/api/auth/settings"
    await alice.put(url, json={"training_auto_advance": True, "training_auto_check": True})
    only_advance = await alice.put(url, json={"training_auto_check": False})
    preferences = only_advance.json()["preferences"]
    assert preferences["training_auto_advance"] is True
    assert preferences["training_auto_check"] is False
    only_check = await alice.put(url, json={"training_auto_advance": False})
    preferences = only_check.json()["preferences"]
    assert preferences["training_auto_advance"] is False
    assert preferences["training_auto_check"] is False


@pytest.mark.parametrize("invalid", [None, "true", "false", "", 0, 1, 1.0, [], {}])
async def test_auto_check_write_is_strict(alice: Client, invalid: Any) -> None:
    url = "/api/auth/settings"
    await alice.put(url, json={"training_auto_check": True})
    response = await alice.put(url, json={"training_auto_check": invalid, "difficulty": "hard"})
    assert response.status_code == 422
    saved = (await alice.get("/api/auth/me")).json()["user"]["preferences"]
    assert saved["training_auto_check"] is True
    assert (await alice.get("/api/auth/me")).json()["user"]["difficulty"] == "medium"


@pytest.mark.parametrize("stored", [None, "true", "false", 0, 1, [], {}])
def test_invalid_stored_auto_check_defaults_to_off(stored: Any) -> None:
    assert public_preferences({"training_auto_check": stored}).training_auto_check is False
