import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI

from lexicona.config import Settings
from lexicona.infrastructure import dictionary, translation
from tests.conftest import Client
from tests.test_dictionary import archive, build_fixture


def test_transport_rejects_oversize_redirect_and_classifies_timeouts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Response:
        def __enter__(self) -> Any:
            return self

        def __exit__(self, *args: Any) -> None:
            pass

        def read(self, size: int) -> bytes:
            assert size == translation.MAX_RESPONSE_BYTES + 1
            return b"x" * size

    class Opener:
        def open(self, request: Any, timeout: int) -> Any:
            assert timeout == 60
            return Response()

    monkeypatch.setattr(urllib.request, "build_opener", lambda handler: Opener())
    with pytest.raises(translation.TranslationError):
        translation._post("https://openrouter.ai/api/v1/chat/completions", {}, {}, 60)
    assert (
        translation._NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.invalid")  # type: ignore[func-returns-value]
        is None
    )

    class Failure:
        def __init__(self, error: Exception) -> None:
            self.error = error

        def open(self, request: Any, timeout: int) -> Any:
            raise self.error

    for error, expected in [
        (urllib.error.URLError(TimeoutError("secret")), translation.TranslationTimeout),
        (urllib.error.URLError("secret"), translation.TranslationError),
    ]:
        monkeypatch.setattr(
            urllib.request, "build_opener", lambda handler, error=error: Failure(error)
        )
        with pytest.raises(expected) as raised:
            translation._post("https://openrouter.ai/api/v1/chat/completions", {}, {}, 60)
        assert "secret" not in str(raised.value)


@pytest.mark.parametrize("content", ['{"a": 1, "a": 2}', '{"a": NaN}'])
def test_strict_json_rejects_duplicate_keys_and_nonfinite(content: str) -> None:
    with pytest.raises(translation.TranslationError):
        translation._json(content)


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


def test_openrouter_request_and_response(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def post(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: int) -> Any:
        calls.append((url, headers, payload, timeout))
        return {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "reasoning": "private",
                        "content": json.dumps(
                            {
                                "translations": ["первый перевод", "второй перевод"],
                                "transcription_us": "/ˈfɹeɪz/",
                            }
                        ),
                    },
                }
            ]
        }

    monkeypatch.setattr(translation, "_post", post)
    result = translation.translate(
        Settings(
            _env_file=None, translation_provider="openrouter", openrouter_api_key="test-secret"
        ),
        "phrase",
    )
    assert result == translation.MachineTranslation(
        "openrouter", "первый перевод", ("второй перевод",), "/ˈfɹeɪz/"
    )
    url, headers, payload, timeout = calls[0]
    assert url == "https://openrouter.ai/api/v1/chat/completions"
    assert headers == {"Authorization": "Bearer test-secret"}
    assert timeout == 60
    assert payload["model"] == "~deepseek/deepseek-flash-latest"
    assert payload["messages"][1]["content"] == "phrase"
    assert payload["reasoning"] == {"enabled": False}
    assert payload["temperature"] == 0
    schema = payload["response_format"]["json_schema"]["schema"]
    assert schema["properties"]["translations"]["maxItems"] == 3
    assert "transcription_us" in schema["required"]


def test_deepl_failure_falls_back_to_openrouter(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(
        _env_file=None,
        deepl_api_key="deepl-secret",
        openrouter_api_key="openrouter-secret",
    )

    def deepl_failure(key: str, text: str) -> str:
        raise translation.TranslationError

    monkeypatch.setattr(translation, "_deepl", deepl_failure)
    monkeypatch.setattr(
        translation,
        "_openrouter",
        lambda key, model, text: translation.MachineTranslation(
            "openrouter", "основной", ("альтернатива",), "/ˈfɹeɪz/"
        ),
    )
    assert translation.translate(settings, "phrase") == translation.MachineTranslation(
        "openrouter", "основной", ("альтернатива",), "/ˈfɹeɪz/"
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
        translation.translate(Settings(_env_file=None, translation_provider="openrouter"), "phrase")
        is None
    )
    assert translation.translate(Settings(_env_file=None, deepl_api_key=""), "phrase") is None
    assert (
        translation.translate(
            Settings(_env_file=None, translation_provider="openrouter", openrouter_api_key=""),
            "phrase",
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


@pytest.mark.parametrize(
    "response",
    [
        {},
        {"choices": []},
        {"choices": [{"message": {"reasoning": "{}"}, "finish_reason": "stop"}]},
        {"choices": [{"message": {"content": "{}"}, "finish_reason": "length"}]},
        {"choices": [{"message": {"content": "not json"}, "finish_reason": "stop"}]},
        {
            "choices": [
                {
                    "message": {
                        "content": '{"translations":["кот"],"transcription_us":"", "extra":1}'
                    },
                    "finish_reason": "stop",
                }
            ]
        },
    ],
)
def test_invalid_openrouter_response(response: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(translation, "_post", lambda *args: response)
    with pytest.raises(translation.TranslationError):
        translation.translate(
            Settings(
                _env_file=None, translation_provider="openrouter", openrouter_api_key="test-secret"
            ),
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
            "openrouter", "перевод", ("вариант",), "/ˈfɹeɪz/"
        ),
    )

    def unexpected(settings: Settings, text: str) -> str:
        raise AssertionError("IPA is already present")

    monkeypatch.setattr(translation, "transcribe", unexpected)
    response = await alice.post("/api/dictionary/lookup", json={"headword": "phrase"})
    assert response.status_code == 200
    body = response.json()
    assert body["machine_translation"] == {
        "provider": "openrouter",
        "text": "перевод",
        "alternatives": ["вариант"],
        "transcription": "/ˈfɹeɪz/",
    }
    assert body["machine_transcription"] is None


async def test_dictionary_phrase_without_ipa_gets_generated_transcription(
    app: FastAPI, alice: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    def lookup(path: Path, headword: str) -> dict[str, Any]:
        return {
            "source": dictionary.SOURCE,
            "matches": [
                {
                    "entry_id": 7,
                    "headword": headword,
                    "part_of_speech": "v",
                    "translations": ["перейти к делу"],
                    "transcriptions": [],
                    "match": "exact",
                }
            ],
            "spelling_suggestions": [],
        }

    monkeypatch.setattr(dictionary, "lookup", lookup)

    def unexpected(settings: Settings, text: str) -> translation.MachineTranslation:
        raise AssertionError("dictionary hit")

    monkeypatch.setattr(translation, "translate", unexpected)
    seen: list[str] = []

    def transcribe(settings: Settings, text: str) -> str:
        seen.append(text)
        return "/ˌkʌt tə ðə ˈtʃeɪs/"

    monkeypatch.setattr(translation, "transcribe", transcribe)
    response = await alice.post("/api/dictionary/lookup", json={"headword": "cut to the chase"})
    assert response.status_code == 200
    body = response.json()
    assert body["machine_translation"] is None
    assert body["machine_transcription"] == "/ˌkʌt tə ðə ˈtʃeɪs/"
    assert body["matches"][0]["translations"] == ["перейти к делу"]
    assert seen == ["cut to the chase"]


async def test_dictionary_ipa_skips_generation(
    app: FastAPI, alice: Client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "index.sqlite3"
    build_fixture(monkeypatch, path, archive())
    app.state.settings.dictionary_path = path

    def unexpected(settings: Settings, text: str) -> str:
        raise AssertionError("dictionary IPA exists")

    monkeypatch.setattr(translation, "transcribe", unexpected)
    response = await alice.post("/api/dictionary/lookup", json={"headword": "apple"})
    assert response.status_code == 200
    body = response.json()
    assert body["matches"][0]["transcriptions"] == ["/a/"]
    assert body["machine_translation"] is None
    assert body["machine_transcription"] is None


async def test_transcription_failure_keeps_dictionary_phrase(
    app: FastAPI, alice: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        dictionary,
        "lookup",
        lambda path, headword: {
            "source": dictionary.SOURCE,
            "matches": [
                {
                    "entry_id": 7,
                    "headword": headword,
                    "part_of_speech": "v",
                    "translations": ["перейти к делу"],
                    "transcriptions": [],
                    "match": "exact",
                }
            ],
            "spelling_suggestions": [],
        },
    )

    def timeout(settings: Settings, text: str) -> None:
        raise translation.TranslationTimeout

    monkeypatch.setattr(translation, "transcribe", timeout)
    response = await alice.post("/api/dictionary/lookup", json={"headword": "cut to the chase"})
    assert response.status_code == 200
    body = response.json()
    assert body["machine_transcription"] is None
    assert body["matches"][0]["translations"] == ["перейти к делу"]


async def test_deepl_translation_receives_generated_ipa(
    app: FastAPI, alice: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    app.state.settings.dictionary_path = Path("/missing/index.sqlite3")
    monkeypatch.setattr(
        translation,
        "translate",
        lambda settings, text: translation.MachineTranslation("deepl", "перейти к делу"),
    )
    monkeypatch.setattr(translation, "transcribe", lambda settings, text: "/ˌkʌt tə ðə ˈtʃeɪs/")
    response = await alice.post("/api/dictionary/lookup", json={"headword": "cut to the chase"})
    assert response.status_code == 200
    body = response.json()
    assert body["matches"] == []
    assert body["machine_transcription"] is None
    assert body["machine_translation"] == {
        "provider": "deepl",
        "text": "перейти к делу",
        "alternatives": [],
        "transcription": "/ˌkʌt tə ðə ˈtʃeɪs/",
    }


def test_transcribe_requests_complete_phrase_ipa(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def post(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: int) -> Any:
        calls.append((url, headers, payload, timeout))
        return {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": json.dumps({"transcription_us": "  /ˌkʌt tə ðə ˈtʃeɪs/  "})
                    },
                }
            ]
        }

    monkeypatch.setattr(translation, "_post", post)
    result = translation.transcribe(
        Settings(_env_file=None, openrouter_api_key="test-secret"), "cut to the chase"
    )
    assert result == "/ˌkʌt tə ðə ˈtʃeɪs/"
    url, headers, payload, timeout = calls[0]
    assert url == "https://openrouter.ai/api/v1/chat/completions"
    assert headers == {"Authorization": "Bearer test-secret"}
    assert timeout == 60
    assert payload["messages"][1]["content"] == "cut to the chase"
    assert "ˈ" in payload["messages"][0]["content"]
    assert "function words" in payload["messages"][0]["content"]
    schema = payload["response_format"]["json_schema"]["schema"]
    assert schema["required"] == ["transcription_us"]
    assert "translations" not in schema["properties"]


def test_transcribe_without_key_does_not_call_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    def unexpected(*args: object) -> None:
        raise AssertionError("no key")

    monkeypatch.setattr(translation, "_post", unexpected)
    assert translation.transcribe(Settings(_env_file=None), "cut to the chase") is None
    assert (
        translation.transcribe(Settings(_env_file=None, openrouter_api_key=""), "cut to the chase")
        is None
    )


@pytest.mark.parametrize(
    "content",
    ["{}", '{"transcription_us":"' + ("a" * 301) + '"}', '{"transcription_us":1}'],
)
def test_invalid_transcription_response(content: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        translation,
        "_post",
        lambda *args: {"choices": [{"finish_reason": "stop", "message": {"content": content}}]},
    )
    with pytest.raises(translation.TranslationError):
        translation.transcribe(
            Settings(_env_file=None, openrouter_api_key="test-secret"), "cut to the chase"
        )


def test_empty_transcription_is_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        translation,
        "_post",
        lambda *args: {
            "choices": [
                {"finish_reason": "stop", "message": {"content": '{"transcription_us":"   "}'}}
            ]
        },
    )
    assert (
        translation.transcribe(
            Settings(_env_file=None, openrouter_api_key="test-secret"), "cut to the chase"
        )
        is None
    )


def test_openrouter_example_request_and_response(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def post(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: int) -> Any:
        calls.append(payload)
        return {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": json.dumps(
                            {"example_en": "A useful phrase", "example_ru": "Полезная фраза"}
                        )
                    },
                }
            ]
        }

    monkeypatch.setattr(translation, "_post", post)
    result = translation.generate_example(
        Settings(_env_file=None, openrouter_api_key="test-secret"), "phrase", ["An old phrase"]
    )
    assert result == ("A useful phrase", "Полезная фраза")
    assert json.loads(calls[0]["messages"][1]["content"]) == {
        "headword": "phrase",
        "previous_examples": ["An old phrase"],
    }
    assert calls[0]["temperature"] == 0.9
    assert "substantially different" in calls[0]["messages"][0]["content"]
    schema = calls[0]["response_format"]["json_schema"]["schema"]
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


@pytest.mark.parametrize(
    "endpoint,method,detail",
    [
        ("lookup", "translate", "dictionary_timeout"),
        ("example", "generate_example", "examples_timeout"),
    ],
)
async def test_provider_timeout_is_safe_504(
    app: FastAPI,
    alice: Client,
    monkeypatch: pytest.MonkeyPatch,
    endpoint: str,
    method: str,
    detail: str,
) -> None:
    app.state.settings.dictionary_path = Path("/missing/index.sqlite3")

    def fail(*args: Any) -> None:
        raise translation.TranslationTimeout("secret")

    monkeypatch.setattr(translation, method, fail)
    response = await alice.post(f"/api/dictionary/{endpoint}", json={"headword": "phrase"})
    assert response.status_code == 504 and response.json() == {"detail": detail}
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "endpoint,method,detail",
    [
        ("lookup", "translate", "dictionary_unavailable"),
        ("example", "generate_example", "examples_unavailable"),
    ],
)
async def test_provider_failure_is_safe_503(
    app: FastAPI,
    alice: Client,
    monkeypatch: pytest.MonkeyPatch,
    endpoint: str,
    method: str,
    detail: str,
) -> None:
    app.state.settings.dictionary_path = Path("/missing/index.sqlite3")

    def fail(*args: Any) -> None:
        raise translation.TranslationError("secret")

    monkeypatch.setattr(translation, method, fail)
    response = await alice.post(f"/api/dictionary/{endpoint}", json={"headword": "phrase"})
    assert response.status_code == 503 and response.json() == {"detail": detail}
    assert response.headers["cache-control"] == "no-store"
