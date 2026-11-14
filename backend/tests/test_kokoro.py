import asyncio
import hashlib
import io
import os
import subprocess
import sys
import threading
import urllib.request
import wave
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI

from lexicona.infrastructure import kokoro, tts
from tests.conftest import Client

VOICE = "kokoro-af_heart"


def install_fake_models(directory: Path) -> None:
    root = directory / "kokoro"
    root.mkdir(parents=True)
    for name in kokoro.FILES:
        (root / name).write_bytes(b"model")


@pytest.fixture
def fake_worker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    script = tmp_path / "fake_worker.py"
    script.write_text(
        """
import io, json, struct, sys, time, wave
out = sys.stdout.buffer
for line in sys.stdin.buffer:
    request = json.loads(line)
    text = request['text']
    if text == 'hang':
        time.sleep(20)
    if text == 'crash':
        sys.exit(1)
    if text == 'empty':
        out.write(struct.pack('!I', 0)); out.flush(); continue
    if text == 'oversize':
        out.write(struct.pack('!I', 16 * 1024 * 1024 + 1)); out.flush(); continue
    if text == 'truncated':
        out.write(struct.pack('!I', 100) + b'short'); out.flush(); sys.exit(1)
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(24000)
        wav.writeframes((request['voice'] + ':' + str(request['rate']) + ':' + text).encode() * 2)
    data = buffer.getvalue()
    out.write(struct.pack('!I', len(data)) + data); out.flush()
"""
    )
    install_fake_models(tmp_path)

    def start(directory: Path, python: Path) -> subprocess.Popen[bytes]:
        if kokoro._worker is None or kokoro._worker.poll() is not None:
            kokoro._worker = subprocess.Popen(  # noqa: S603 -- local test script
                [sys.executable, str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE
            )
        return kokoro._worker

    monkeypatch.setattr(kokoro, "_start_worker", start)
    monkeypatch.setattr(kokoro, "runtime_available", lambda python: True)
    yield tmp_path
    kokoro.close_worker()


def test_catalog_requires_both_models(tmp_path: Path) -> None:
    assert kokoro.voices(tmp_path) == []
    install_fake_models(tmp_path)
    assert [voice["id"] for voice in kokoro.voices(tmp_path)] == list(kokoro.VOICES)
    assert {voice["language"] for voice in kokoro.voices(tmp_path)} == {"en-US", "en-GB"}
    (tmp_path / "kokoro" / "voices-v1.0.bin").unlink()
    assert kokoro.voices(tmp_path) == []


def test_runtime_probe_rejects_missing_and_unusable_interpreters(tmp_path: Path) -> None:
    assert not kokoro.runtime_available(tmp_path / "missing")
    script = tmp_path / "python"
    script.write_text("#!/bin/sh\nexit 1\n")
    script.chmod(0o755)
    assert not kokoro.runtime_available(script)


async def test_api_auth_csrf_voice_selection_and_synthesis(
    app: FastAPI, anon: Client, alice: Client, bob: Client, fake_worker: Path
) -> None:
    app.state.settings.tts_engine = "kokoro"
    app.state.settings.kokoro_python = Path(sys.executable)
    app.state.settings.tts_dir = fake_worker
    assert (await anon.get("/api/speech/voices")).status_code == 401
    listing = await bob.get("/api/speech/voices")
    assert listing.status_code == 200 and listing.headers["cache-control"] == "no-store"
    assert listing.json()["available"] and len(listing.json()["voices"]) == 4
    payload = {"text": "hello", "voice_id": VOICE, "rate": 0.75}
    alice.headers.pop("X-CSRF-Token")
    assert (await alice.post("/api/speech/synthesize", json=payload)).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    response = await alice.post("/api/speech/synthesize", json=payload)
    assert response.status_code == 200 and response.headers["content-type"] == "audio/wav"
    assert response.headers["cache-control"] == "no-store"
    with wave.open(io.BytesIO(response.content)) as audio:
        assert b"af_heart:0.75:hello" in audio.readframes(audio.getnframes())
    assert (
        await alice.post("/api/speech/synthesize", json=payload | {"voice_id": "en_US-lessac-high"})
    ).status_code == 422
    app.state.settings.tts_engine = "piper"
    assert (await alice.post("/api/speech/synthesize", json=payload)).status_code == 422


async def test_slow_runtime_probe_does_not_block_health(
    app: FastAPI, alice: Client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fake_models(tmp_path)
    app.state.settings.tts_engine = "kokoro"
    app.state.settings.tts_dir = tmp_path
    entered = threading.Event()
    release = threading.Event()

    def slow_probe(python: Path) -> bool:
        entered.set()
        return release.wait(2)

    monkeypatch.setattr(kokoro, "runtime_available", slow_probe)
    request = asyncio.create_task(alice.get("/api/speech/voices"))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        assert not request.done()
        response = await asyncio.wait_for(alice.get("/api/health"), timeout=0.5)
        assert response.status_code == 200
        assert not request.done()
    finally:
        release.set()
        await request


def test_worker_reuse_long_input_cache_crash_and_restart(fake_worker: Path) -> None:
    python = Path(sys.executable)
    first = kokoro.synthesize(fake_worker, python, VOICE, "a" * 2000, 1)
    initial = kokoro._worker
    assert initial is not None and initial.poll() is None
    assert kokoro.synthesize(fake_worker, python, VOICE, "a" * 2000, 1) == first
    assert kokoro._worker is initial
    with wave.open(io.BytesIO(first)) as audio:
        assert b"a" * 2000 in audio.readframes(audio.getnframes())
    with pytest.raises(tts.SpeechError):
        kokoro.synthesize(fake_worker, python, VOICE, "crash", 1)
    assert initial.poll() is not None and kokoro._worker is None
    assert kokoro.synthesize(fake_worker, python, VOICE, "new", 1)
    assert kokoro._worker is not initial
    for invalid in ("empty", "oversize", "truncated"):
        with pytest.raises(tts.SpeechError):
            kokoro.synthesize(fake_worker, python, VOICE, invalid, 1)
        assert kokoro._worker is None
        assert kokoro.synthesize(fake_worker, python, VOICE, "after " + invalid, 1)


def test_timeout_kills_worker_and_allows_next_request(
    fake_worker: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(kokoro, "TIMEOUT_SECONDS", 0.1)
    with pytest.raises(tts.SpeechTimeout):
        kokoro.synthesize(fake_worker, Path(sys.executable), VOICE, "hang", 1)
    assert kokoro._worker is None
    assert kokoro.synthesize(fake_worker, Path(sys.executable), VOICE, "after", 1)


async def test_cancellation_does_not_release_slot_while_worker_busy(
    fake_worker: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(kokoro, "TIMEOUT_SECONDS", 0.3)
    entered = threading.Event()
    original = kokoro._exchange

    def exchange(*args: Any) -> bytes:
        entered.set()
        return original(*args)

    monkeypatch.setattr(kokoro, "_exchange", exchange)
    task = asyncio.create_task(
        asyncio.to_thread(kokoro.synthesize, fake_worker, Path(sys.executable), VOICE, "hang", 1)
    )
    assert await asyncio.to_thread(entered.wait, 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    with pytest.raises(tts.SpeechBusy):
        kokoro.synthesize(fake_worker, Path(sys.executable), VOICE, "other", 1)
    for _ in range(100):
        if kokoro._slot.acquire(blocking=False):
            kokoro._slot.release()
            break
        await asyncio.sleep(0.01)
    else:
        pytest.fail("slot not released after timeout")
    assert kokoro.synthesize(fake_worker, Path(sys.executable), VOICE, "ok", 1)


def test_download_checks_size_hash_and_preserves_existing_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = b"model"
    expected = hashlib.sha256(data).hexdigest()
    monkeypatch.setattr(kokoro, "FILES", {"model": (len(data), expected)})
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **kw: io.BytesIO(data))
    kokoro.download(tmp_path)
    target = tmp_path / "kokoro" / "model"
    assert target.read_bytes() == data
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **kw: io.BytesIO(b"wrong"))
    kokoro.download(tmp_path)
    monkeypatch.setattr(kokoro, "FILES", {"model": (len(data), "0" * 64)})
    with pytest.raises(tts.SpeechError):
        kokoro.download(tmp_path)
    assert target.read_bytes() == data
    assert os.listdir(target.parent) == ["model"]
