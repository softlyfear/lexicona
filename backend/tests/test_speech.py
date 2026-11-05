import asyncio
import hashlib
import importlib.resources
import io
import json
import threading
import time
import urllib.request
import wave
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI

from lexicona import tts
from tests.conftest import Client

VOICE = "en_US-lessac-medium"


def fake_model(root: Path) -> None:
    directory = root / VOICE
    directory.mkdir(parents=True)
    (directory / f"{VOICE}.onnx").write_bytes(b"model")
    (directory / f"{VOICE}.onnx.json").write_bytes(b"config")


def wav_bytes() -> bytes:
    data = io.BytesIO()
    with wave.open(data, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(22050)
        wav.writeframes(b"\x00\x00" * 10)
    return data.getvalue()


async def test_speech_auth_csrf_and_partial_voices(
    app: FastAPI,
    anon: Client,
    alice: Client,
    bob: Client,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app.state.settings.tts_dir = tmp_path
    fake_model(tmp_path)
    monkeypatch.setattr(tts, "runtime_available", lambda: True)
    assert (await anon.get("/api/speech/voices")).status_code == 401
    response = await bob.get("/api/speech/voices")
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "available": True,
        "voices": [{"id": VOICE, "name": "Lessac", "language": "en-US", "gender": "female"}],
    }
    payload = {"text": "test", "voice_id": VOICE, "rate": 0.75}
    alice.headers.pop("X-CSRF-Token")
    assert (await alice.post("/api/speech/synthesize", json=payload)).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    calls = []

    def synthesize(directory: Path, voice_id: str, text: str, rate: float) -> bytes:
        calls.append((directory, voice_id, text, rate))
        return wav_bytes()

    monkeypatch.setattr(tts, "synthesize", synthesize)
    response = await alice.post("/api/speech/synthesize", json=payload)
    assert response.status_code == 200 and response.headers["content-type"] == "audio/wav"
    assert response.headers["cache-control"] == "no-store" and response.content == wav_bytes()
    assert calls == [(tmp_path, VOICE, "test", 0.75)]


async def test_missing_voice_and_runtime(
    app: FastAPI, alice: Client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app.state.settings.tts_dir = tmp_path
    monkeypatch.setattr(tts, "runtime_available", lambda: True)
    assert (await alice.get("/api/speech/voices")).json() == {"available": False, "voices": []}
    payload = {"text": "test", "voice_id": VOICE, "rate": 1}
    response = await alice.post("/api/speech/synthesize", json=payload)
    assert response.status_code == 503 and response.json()["detail"] == "speech_unavailable"
    fake_model(tmp_path)
    monkeypatch.setattr(tts, "runtime_available", lambda: False)
    response = await alice.get("/api/speech/voices")
    assert not response.json()["available"] and len(response.json()["voices"]) == 1
    assert (await alice.post("/api/speech/synthesize", json=payload)).status_code == 503


@pytest.mark.parametrize(
    "change",
    [
        {"voice_id": "../../secret"},
        {"voice_id": "missing"},
        {"text": " "},
        {"text": "a" * 2001},
        {"text": 1},
        {"rate": True},
        {"rate": "1"},
        {"rate": 0.5},
        {"extra": "x"},
        {"text": " " * 2001},
    ],
)
async def test_speech_rejects_invalid_inputs(alice: Client, change: dict[str, Any]) -> None:
    payload = {"text": "test", "voice_id": VOICE, "rate": 1} | change
    response = await alice.post("/api/speech/synthesize", json=payload)
    assert response.status_code == 422 and response.headers["cache-control"] == "no-store"


async def test_speech_rejects_unpaired_surrogate(alice: Client) -> None:
    body = b'{"text":"\\ud800","voice_id":"en_US-lessac-medium","rate":1}'
    response = await alice.post(
        "/api/speech/synthesize", content=body, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "error,code,detail",
    [
        (tts.SpeechError, 503, "speech_unavailable"),
        (tts.SpeechBusy, 503, "speech_busy"),
        (tts.SpeechTimeout, 504, "speech_timeout"),
    ],
)
async def test_speech_errors_are_safe(
    alice: Client, monkeypatch: pytest.MonkeyPatch, error: type[Exception], code: int, detail: str
) -> None:
    def fail(*args: Any) -> bytes:
        raise error("private")

    monkeypatch.setattr(tts, "synthesize", fail)
    response = await alice.post(
        "/api/speech/synthesize", json={"text": "private", "voice_id": VOICE, "rate": 1}
    )
    assert response.status_code == code and response.json() == {"detail": detail}


def test_synthesis_timeout_keeps_the_slot_until_render_finishes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_model(tmp_path)
    tts.reset_caches()
    monkeypatch.setattr(tts, "runtime_available", lambda: True)
    monkeypatch.setattr(tts, "TIMEOUT_SECONDS", 0)
    release = threading.Event()

    def render(*args: Any, **kwargs: Any) -> bytes:
        release.wait()
        return wav_bytes()

    monkeypatch.setattr(tts, "_render", render)
    with pytest.raises(tts.SpeechTimeout):
        tts.synthesize(tmp_path, VOICE, "private", 0.75)
    with pytest.raises(tts.SpeechBusy):
        tts.synthesize(tmp_path, VOICE, "other", 0.75)
    release.set()
    for _ in range(100):
        if tts._slot.acquire(blocking=False):
            tts._slot.release()
            return
        time.sleep(0.01)
    pytest.fail("slot was not released")


def test_loaded_voice_and_clip_are_reused_without_cuda(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_model(tmp_path)
    tts.reset_caches()
    monkeypatch.setattr(tts, "runtime_available", lambda: True)
    loads: list[Path] = []
    renders = 0

    class Voice:
        def synthesize_wav(
            self, text: str, wav_file: wave.Wave_write, syn_config: Any = None, **kwargs: Any
        ) -> None:
            assert syn_config.length_scale == pytest.approx(1 / 0.75)
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(22050)
            sample = text.encode()[:2].ljust(2, b"\x00")
            wav_file.writeframes(sample * 8)

    def load(model: Path, use_cuda: bool = False, **kwargs: Any) -> Voice:
        assert use_cuda is False
        loads.append(Path(model))
        return Voice()

    import piper

    monkeypatch.setattr(piper.PiperVoice, "load", staticmethod(load))
    original = tts._render

    def counting(*args: Any, **kwargs: Any) -> bytes:
        nonlocal renders
        renders += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(tts, "_render", counting)
    first = tts.synthesize(tmp_path, VOICE, "one", 0.75)
    second = tts.synthesize(tmp_path, VOICE, "two", 0.75)
    third = tts.synthesize(tmp_path, VOICE, "one", 0.75)
    assert first == third and first != second
    assert renders == 2 and len(loads) == 1
    assert loads[0].name == f"{VOICE}.onnx"


@pytest.mark.parametrize("data", [b"invalid", b"R" * 1025, wav_bytes()[:-1]])
def test_synthesis_rejects_bad_or_oversize_wav(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, data: bytes
) -> None:
    fake_model(tmp_path)
    tts.reset_caches()
    monkeypatch.setattr(tts, "runtime_available", lambda: True)
    monkeypatch.setattr(tts, "MAX_WAV_BYTES", 1024)
    monkeypatch.setattr(tts, "_render", lambda *args, **kwargs: data)
    with pytest.raises(tts.SpeechError):
        tts.synthesize(tmp_path, VOICE, "test", 1)


async def test_cancelled_request_keeps_slot_until_child_exits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_model(tmp_path)
    tts.reset_caches()
    monkeypatch.setattr(tts, "runtime_available", lambda: True)
    entered = threading.Event()
    release = threading.Event()
    exited = threading.Event()

    def render(*args: Any, **kwargs: Any) -> bytes:
        entered.set()
        release.wait()
        exited.set()
        return wav_bytes()

    monkeypatch.setattr(tts, "_render", render)
    task = asyncio.create_task(asyncio.to_thread(tts.synthesize, tmp_path, VOICE, "test", 1.0))
    assert await asyncio.to_thread(entered.wait, 3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    with pytest.raises(tts.SpeechBusy):
        await asyncio.to_thread(tts.synthesize, tmp_path, VOICE, "test", 1.0)
    release.set()
    assert await asyncio.to_thread(exited.wait, 3)
    for _ in range(100):
        if tts._slot.acquire(blocking=False):
            tts._slot.release()
            break
        await asyncio.sleep(0.01)
    else:
        pytest.fail("slot was not released")


def test_catalog_matches_pinned_manifest() -> None:
    manifest = json.loads(
        importlib.resources.files("lexicona").joinpath("tts_manifest.json").read_text("utf-8")
    )
    assert manifest["revision"] == tts.REVISION
    assert list(manifest["voices"]) == list(tts.VOICES)
    added = {
        "en_US-amy-medium": ("Amy", "en-US", "female"),
        "en_US-bryce-medium": ("Bryce", "en-US", "male"),
        "en_US-hfc_female-medium": ("HFC Female", "en-US", "female"),
        "en_US-hfc_male-medium": ("HFC Male", "en-US", "male"),
        "en_US-john-medium": ("John", "en-US", "male"),
        "en_US-kusal-medium": ("Kusal", "en-US", "male"),
        "en_US-ljspeech-medium": ("LJ Speech", "en-US", "female"),
        "en_US-norman-medium": ("Norman", "en-US", "male"),
        "en_US-reza_ibrahim-medium": ("Reza Ibrahim", "en-US", "male"),
        "en_US-sam-medium": ("Sam", "en-US", "nonbinary"),
        "en_GB-cori-medium": ("Cori", "en-GB", "female"),
        "ru_RU-irina-medium": ("Irina", "ru-RU", "female"),
        "ru_RU-ruslan-medium": ("Ruslan", "ru-RU", "male"),
    }
    assert len(tts.VOICES) == 23
    for voice_id, meta in added.items():
        assert tts.VOICES[voice_id] == meta
    assert next(voice for voice, meta in tts.VOICES.items() if meta[1] == "en-US") == (
        "en_US-lessac-medium"
    )
    assert next(voice for voice, meta in tts.VOICES.items() if meta[1] == "en-GB") == (
        "en_GB-alba-medium"
    )
    assert next(voice for voice, meta in tts.VOICES.items() if meta[1] == "ru-RU") == (
        "ru_RU-denis-medium"
    )
    for voice_id, files in manifest["voices"].items():
        language, _name, quality = voice_id.split("-")
        assert quality == "medium" and language in {"en_US", "en_GB", "ru_RU"}
        assert tts.VOICES[voice_id][2] in {"female", "male", "nonbinary"}
        assert [item["file"] for item in files] == [
            f"{voice_id}.onnx",
            f"{voice_id}.onnx.json",
            "MODEL_CARD",
        ]
        assert all(len(item["sha256"]) == 64 for item in files)


def test_download_reuses_hash_and_rejects_bad_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "model"
    target.write_bytes(b"good")
    digest = hashlib.sha256(b"good").hexdigest()

    def unexpected(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("existing verified file should be reused")

    monkeypatch.setattr(urllib.request, "urlopen", unexpected)
    tts.download_file("https://example.invalid/model", target, digest)
    monkeypatch.setattr(urllib.request, "urlopen", lambda *args, **kwargs: io.BytesIO(b"bad"))
    with pytest.raises(tts.SpeechError):
        tts.download_file(
            "https://example.invalid/model", target, hashlib.sha256(b"other").hexdigest()
        )
    assert target.read_bytes() == b"good" and list(tmp_path.iterdir()) == [target]
    tts.download_file("https://example.invalid/model", target, hashlib.sha256(b"bad").hexdigest())
    assert target.read_bytes() == b"bad" and list(tmp_path.iterdir()) == [target]
