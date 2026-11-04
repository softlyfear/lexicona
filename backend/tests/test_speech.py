import asyncio
import hashlib
import io
import subprocess
import sys
import threading
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


def test_synthesis_timeout_kills_child_and_removes_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_model(tmp_path)
    monkeypatch.setattr(tts, "runtime_available", lambda: True)
    monkeypatch.setattr(tts, "TIMEOUT_SECONDS", 0)
    paths: list[Path] = []

    class Child:
        returncode: int | None = None
        killed = False

        def poll(self) -> int | None:
            return -9 if self.killed else None

        def kill(self) -> None:
            self.killed = True

        def wait(self) -> int:
            return -9

    child = Child()

    def spawn(cmd: list[str], **kwargs: Any) -> Child:
        assert cmd[0:3] == [sys.executable, "-m", "piper"]
        assert "--cuda" not in cmd and cmd[-1] == str(1 / 0.75)
        paths.append(Path(cmd[cmd.index("-f") + 1]).parent)
        return child

    monkeypatch.setattr(subprocess, "Popen", spawn)
    with pytest.raises(tts.SpeechTimeout):
        tts.synthesize(tmp_path, VOICE, "private", 0.75)
    assert child.killed and not paths[0].exists()


@pytest.mark.parametrize("data", [b"invalid", b"R" * 1025, wav_bytes()[:-1]])
def test_synthesis_rejects_bad_or_oversize_wav(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, data: bytes
) -> None:
    fake_model(tmp_path)
    monkeypatch.setattr(tts, "runtime_available", lambda: True)
    monkeypatch.setattr(tts, "MAX_WAV_BYTES", 1024)

    class Child:
        returncode = 0

        def poll(self) -> int:
            return 0

        def wait(self) -> int:
            return 0

    def spawn(cmd: list[str], **kwargs: Any) -> Child:
        Path(cmd[cmd.index("-f") + 1]).write_bytes(data)
        return Child()

    monkeypatch.setattr(subprocess, "Popen", spawn)
    with pytest.raises(tts.SpeechError):
        tts.synthesize(tmp_path, VOICE, "test", 1)


async def test_cancelled_request_keeps_slot_until_child_exits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_model(tmp_path)
    monkeypatch.setattr(tts, "runtime_available", lambda: True)
    entered = threading.Event()
    release = threading.Event()
    exited = threading.Event()

    class Child:
        returncode = 1

        def poll(self) -> int | None:
            entered.set()
            return 1 if release.is_set() else None

        def kill(self) -> None:
            release.set()

        def wait(self) -> int:
            exited.set()
            return 1

    monkeypatch.setattr(subprocess, "Popen", lambda *args, **kwargs: Child())
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
