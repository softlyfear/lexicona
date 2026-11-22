import json
import threading
from typing import Any

import pytest
from fastapi import FastAPI
from pydantic import SecretStr
from sqlalchemy import select

from lexicona.infrastructure import dictionary, translation
from lexicona.infrastructure.db import Database
from lexicona.infrastructure.models import Base
from tests.conftest import Client, add_word

URL = "/api/dictionary/transcription"


def unexpected(*args: Any, **kwargs: Any) -> Any:
    raise AssertionError("lookup/translation/provider call must not occur")


async def stored_data(database: Database) -> dict[str, list[dict[str, Any]]]:
    async with database.sessions() as db:
        return {
            table.name: [dict(row) for row in (await db.execute(select(table))).mappings()]
            for table in Base.metadata.sorted_tables
        }


@pytest.mark.parametrize(
    ("dialect", "field", "accent"),
    [
        ({}, "transcription_us", "General American"),
        ({"dialect": "UK"}, "transcription_uk", "Standard British"),
    ],
)
async def test_transcription_is_input_only_threaded_and_does_not_mutate_accounts(
    app: FastAPI,
    alice: Client,
    bob: Client,
    monkeypatch: pytest.MonkeyPatch,
    dialect: dict[str, str],
    field: str,
    accent: str,
) -> None:
    await add_word(alice, "cut to the chase", "перевод владельца", transcription="/old/")
    await add_word(bob, "cut to the chase", "другой перевод", transcription="/different/")
    before = await stored_data(app.state.db)
    app.state.settings.openrouter_api_key = SecretStr("test-secret")
    monkeypatch.setattr(dictionary, "lookup", unexpected)
    monkeypatch.setattr(translation, "translate", unexpected)
    caller_thread = threading.get_ident()
    calls = []

    def provider(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: int) -> Any:
        assert threading.get_ident() != caller_thread
        assert payload["messages"][1]["content"] == "cut to the chase"
        assert accent in payload["messages"][0]["content"]
        schema = payload["response_format"]["json_schema"]["schema"]
        assert schema["required"] == [field]
        assert set(schema["properties"]) == {field}
        calls.append(payload)
        return {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"content": json.dumps({field: " /ˌkʌt tə ðə ˈtʃeɪs/ "})},
                }
            ]
        }

    monkeypatch.setattr(translation, "_post", provider)
    for client in (alice, bob):
        response = await client.post(URL, json={"headword": "  cut to the chase  ", **dialect})
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.json() == {"transcription": "/ˌkʌt tə ðə ˈtʃeɪs/"}
    assert len(calls) == 2
    assert await stored_data(app.state.db) == before


async def test_transcription_requires_auth_and_csrf(
    alice: Client, anon: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(translation, "transcribe", unexpected)
    response = await anon.post(URL, json={"headword": "phrase"})
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"
    alice.headers.pop("X-CSRF-Token")
    response = await alice.post(URL, json={"headword": "phrase"})
    assert response.status_code == 403
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("key", [None, ""])
async def test_missing_key_is_safe_unavailable(
    app: FastAPI, alice: Client, monkeypatch: pytest.MonkeyPatch, key: str | None
) -> None:
    app.state.settings.openrouter_api_key = SecretStr(key) if key is not None else None
    monkeypatch.setattr(translation, "_post", unexpected)
    response = await alice.post(URL, json={"headword": "phrase"})
    assert response.status_code == 503
    assert response.json() == {"detail": "transcription_unavailable"}
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "generated",
    [
        {},
        {"transcription_us": ""},
        {"transcription_us": "  "},
        {"transcription_us": "a" * 301},
        {"transcription_us": None},
        {"transcription_us": 1},
        {"transcription_us": "/a/", "translations": ["not IPA"]},
    ],
)
async def test_empty_or_invalid_provider_ipa_is_safe_unavailable(
    app: FastAPI, alice: Client, monkeypatch: pytest.MonkeyPatch, generated: dict[str, Any]
) -> None:
    app.state.settings.openrouter_api_key = SecretStr("test-secret")
    monkeypatch.setattr(translation, "_openrouter_request", lambda *args: generated)
    response = await alice.post(URL, json={"headword": "phrase"})
    assert response.status_code == 503
    assert response.json() == {"detail": "transcription_unavailable"}
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    ("error", "status", "detail"),
    [
        (
            translation.TranslationError("private provider failure"),
            503,
            "transcription_unavailable",
        ),
        (translation.TranslationTimeout("private provider failure"), 504, "transcription_timeout"),
    ],
)
async def test_provider_errors_are_classified_without_disclosure(
    app: FastAPI,
    alice: Client,
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    status: int,
    detail: str,
) -> None:
    app.state.settings.openrouter_api_key = SecretStr("test-secret")

    def failed(*args: Any) -> Any:
        raise error

    monkeypatch.setattr(translation, "_post", failed)
    response = await alice.post(URL, json={"headword": "phrase"})
    assert response.status_code == status
    assert response.json() == {"detail": detail}
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"headword": ""},
        {"headword": "  "},
        {"headword": "a" * 201},
        {"headword": None},
        {"headword": 1},
        {"headword": True},
        {"headword": []},
        {"headword": "phone", "dialect": "AU"},
    ],
)
async def test_transcription_input_bounds_prevent_provider_calls(
    alice: Client, monkeypatch: pytest.MonkeyPatch, body: dict[str, Any]
) -> None:
    monkeypatch.setattr(translation, "transcribe", unexpected)
    response = await alice.post(URL, json=body)
    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"


async def test_exact_input_and_output_maximum(
    app: FastAPI, alice: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    app.state.settings.openrouter_api_key = SecretStr("test-secret")

    def generated(*args: Any) -> dict[str, str]:
        assert args[2] == "a" * 200
        return {"transcription_us": "/" + "a" * 298 + "/"}

    monkeypatch.setattr(translation, "_openrouter_request", generated)
    response = await alice.post(URL, json={"headword": "a" * 200})
    assert response.status_code == 200
    assert len(response.json()["transcription"]) == 300
