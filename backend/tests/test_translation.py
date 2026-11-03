import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI

from lexicona import translation
from lexicona.config import Settings
from tests.conftest import Client
from tests.test_dictionary import archive, build_fixture


def test_deepl_request_and_response(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def post(url: str, headers: dict[str, str], payload: dict[str, Any]) -> Any:
        calls.append((url, headers, payload))
        return {"translations": [{"text": " притворяйся, пока не получится "}]}

    monkeypatch.setattr(translation, "_post", post)
    result = translation.translate(
        Settings(_env_file=None, translation_provider="deepl", deepl_api_key="test-secret"),
        "fake it till you make it",
    )
    assert result == translation.MachineTranslation("deepl", "притворяйся, пока не получится")
    url, headers, payload = calls[0]
    assert url == "https://api-free.deepl.com/v2/translate"
    assert headers == {"Authorization": "DeepL-Auth-Key test-secret"}
    assert payload == {
        "text": ["fake it till you make it"],
        "source_lang": "EN",
        "target_lang": "RU",
    }


def test_gemini_request_and_response(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def post(url: str, headers: dict[str, str], payload: dict[str, Any]) -> Any:
        calls.append((url, headers, payload))
        return {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {"thought": True, "text": "private reasoning"},
                            {
                                "text": json.dumps(
                                    {
                                        "translations": ["первый перевод", "второй перевод"],
                                        "transcription_us": "/ˈfɹeɪz/",
                                    }
                                )
                            },
                        ]
                    }
                }
            ]
        }

    monkeypatch.setattr(translation, "_post", post)
    result = translation.translate(
        Settings(_env_file=None, translation_provider="gemini", gemini_api_key="test-secret"),
        "phrase",
    )
    assert result == translation.MachineTranslation(
        "gemini", "первый перевод", ("второй перевод",), "/ˈfɹeɪz/"
    )
    url, headers, payload = calls[0]
    assert "gemini-flash-lite-latest:generateContent" in url
    assert headers == {"x-goog-api-key": "test-secret"}
    assert payload["contents"][0]["parts"][0]["text"] == "phrase"
    assert payload["generationConfig"]["responseMimeType"] == "application/json"
    assert payload["generationConfig"]["temperature"] == 0
    schema = payload["generationConfig"]["responseSchema"]
    assert schema["properties"]["translations"]["maxItems"] == 3
    assert "transcription_us" in schema["required"]


def test_deepl_failure_falls_back_to_gemini(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(
        _env_file=None,
        deepl_api_key="deepl-secret",
        gemini_api_key="gemini-secret",
    )

    def deepl_failure(key: str, text: str) -> str:
        raise translation.TranslationError

    monkeypatch.setattr(translation, "_deepl", deepl_failure)
    monkeypatch.setattr(
        translation,
        "_gemini",
        lambda key, model, text: translation.MachineTranslation(
            "gemini", "основной", ("альтернатива",), "/ˈfɹeɪz/"
        ),
    )
    assert translation.translate(settings, "phrase") == translation.MachineTranslation(
        "gemini", "основной", ("альтернатива",), "/ˈfɹeɪz/"
    )


def test_missing_or_empty_key_disables_external_call(monkeypatch: pytest.MonkeyPatch) -> None:
    def unexpected(url: str, headers: dict[str, str], payload: dict[str, Any]) -> None:
        raise AssertionError("external API must not be called")

    monkeypatch.setattr(translation, "_post", unexpected)
    assert (
        translation.translate(Settings(_env_file=None, translation_provider="deepl"), "phrase")
        is None
    )
    assert (
        translation.translate(Settings(_env_file=None, translation_provider="gemini"), "phrase")
        is None
    )
    assert translation.translate(Settings(_env_file=None, deepl_api_key=""), "phrase") is None
    assert (
        translation.translate(
            Settings(_env_file=None, translation_provider="gemini", gemini_api_key=""), "phrase"
        )
        is None
    )


@pytest.mark.parametrize(
    "response",
    [
        {},
        {"translations": []},
        {"translations": [{"text": ""}]},
        {"translations": [{"text": 42}]},
    ],
)
def test_invalid_deepl_response(response: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(translation, "_post", lambda *args: response)
    with pytest.raises(translation.TranslationError):
        translation.translate(Settings(_env_file=None, deepl_api_key="test-secret"), "phrase")


@pytest.mark.parametrize("response", [{}, {"candidates": []}, {"candidates": [{"content": {}}]}])
def test_invalid_gemini_response(response: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(translation, "_post", lambda *args: response)
    with pytest.raises(translation.TranslationError):
        translation.translate(
            Settings(_env_file=None, translation_provider="gemini", gemini_api_key="test-secret"),
            "phrase",
        )


async def test_external_used_only_after_empty_local_lookup(
    app: FastAPI,
    alice: Client,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "index.sqlite3"
    build_fixture(monkeypatch, path, archive())
    app.state.settings.dictionary_path = path
    calls = []

    def external(settings: Settings, text: str) -> translation.MachineTranslation:
        calls.append(text)
        return translation.MachineTranslation("deepl", "внешний перевод")

    monkeypatch.setattr(translation, "translate", external)
    local = await alice.post("/api/dictionary/lookup", json={"headword": "apple"})
    assert local.status_code == 200
    assert local.json()["machine_translation"] is None
    assert calls == []

    missing = await alice.post("/api/dictionary/lookup", json={"headword": "unknown phrase"})
    assert missing.status_code == 200
    assert missing.json()["matches"] == []
    assert missing.json()["machine_translation"] == {
        "provider": "deepl",
        "text": "внешний перевод",
        "alternatives": [],
        "transcription": None,
    }
    assert missing.headers["cache-control"] == "no-store"
    assert calls == ["unknown phrase"]


async def test_external_can_cover_missing_local_index(
    app: FastAPI, alice: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    app.state.settings.dictionary_path = Path("/missing/index.sqlite3")
    monkeypatch.setattr(
        translation,
        "translate",
        lambda settings, text: translation.MachineTranslation(
            "gemini", "перевод", ("вариант",), "/ˈfɹeɪz/"
        ),
    )
    response = await alice.post("/api/dictionary/lookup", json={"headword": "phrase"})
    assert response.status_code == 200
    assert response.json()["machine_translation"] == {
        "provider": "gemini",
        "text": "перевод",
        "alternatives": ["вариант"],
        "transcription": "/ˈfɹeɪz/",
    }


def test_gemini_example_request_and_response(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def post(url: str, headers: dict[str, str], payload: dict[str, Any]) -> Any:
        calls.append(payload)
        return {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "example_en": "A useful phrase",
                                        "example_ru": "Полезная фраза",
                                    }
                                )
                            }
                        ]
                    }
                }
            ]
        }

    monkeypatch.setattr(translation, "_post", post)
    result = translation.generate_example(
        Settings(_env_file=None, gemini_api_key="test-secret"), "phrase", ["An old phrase"]
    )
    assert result == ("A useful phrase", "Полезная фраза")
    assert json.loads(calls[0]["contents"][0]["parts"][0]["text"]) == {
        "headword": "phrase",
        "previous_examples": ["An old phrase"],
    }
    assert calls[0]["generationConfig"]["temperature"] == 0.9
    assert "substantially different" in calls[0]["systemInstruction"]["parts"][0]["text"]
    schema = calls[0]["generationConfig"]["responseSchema"]
    assert schema["required"] == ["example_en", "example_ru"]


async def test_example_auth_csrf_and_errors(
    app: FastAPI, anon: Client, alice: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert (
        await anon.post("/api/dictionary/example", json={"headword": "phrase"})
    ).status_code == 401
    alice.headers.pop("X-CSRF-Token")
    assert (
        await alice.post("/api/dictionary/example", json={"headword": "phrase"})
    ).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    monkeypatch.setattr(
        translation, "generate_example", lambda settings, text, previous_examples: None
    )
    assert (
        await alice.post("/api/dictionary/example", json={"headword": "phrase"})
    ).status_code == 503
    calls = []

    def generated(settings: Settings, text: str, previous_examples: list[str]) -> tuple[str, str]:
        calls.append((text, previous_examples))
        return "A phrase", "Фраза"

    monkeypatch.setattr(translation, "generate_example", generated)
    response = await alice.post(
        "/api/dictionary/example",
        json={"headword": "phrase", "previous_examples": ["An old phrase"]},
    )
    assert response.status_code == 200
    assert response.json() == {"example_en": "A phrase", "example_ru": "Фраза"}
    assert response.headers["cache-control"] == "no-store"
    assert calls == [("phrase", ["An old phrase"])]
    assert (
        await alice.post(
            "/api/dictionary/example",
            json={"headword": "phrase", "previous_examples": [""]},
        )
    ).status_code == 422
    assert (
        await alice.post(
            "/api/dictionary/example",
            json={"headword": "phrase", "previous_examples": ["text"] * 21},
        )
    ).status_code == 422
