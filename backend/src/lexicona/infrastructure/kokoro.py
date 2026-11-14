"""Optional local Kokoro runtime, isolated from the application's Python version."""

import argparse
import hashlib
import json
import os
import struct
import subprocess
import tempfile
import threading
import urllib.request
import wave
from collections import OrderedDict
from pathlib import Path
from typing import Any

from lexicona.config import Settings
from lexicona.infrastructure.tts import SpeechBusy, SpeechError, SpeechTimeout, _validate_wav

VOICES = {
    "kokoro-af_heart": ("Heart", "en-US", "female"),
    "kokoro-am_michael": ("Michael", "en-US", "male"),
    "kokoro-bf_emma": ("Emma", "en-GB", "female"),
    "kokoro-bf_isabella": ("Isabella", "en-GB", "female"),
}
FILES = {
    "kokoro-v1.0.onnx": (
        325505369,
        "beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a",
    ),
    "voices-v1.0.bin": (
        28214398,
        "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    ),
}
MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1"
MAX_WAV_BYTES = 16 * 1024 * 1024
TIMEOUT_SECONDS = 30
_slot = threading.BoundedSemaphore(1)
_worker: subprocess.Popen[bytes] | None = None
_worker_key: tuple[Path, Path] | None = None
_clips: OrderedDict[tuple[Path, Path, str, float, str], bytes] = OrderedDict()


def installed(directory: Path) -> bool:
    root = directory / "kokoro"
    try:
        return all((root / name).is_file() and (root / name).stat().st_size > 0 for name in FILES)
    except OSError:
        return False


def voices(directory: Path) -> list[dict[str, str]]:
    if not installed(directory):
        return []
    return [
        {"id": voice_id, "name": name, "language": language, "gender": gender}
        for voice_id, (name, language, gender) in VOICES.items()
    ]


def runtime_available(python: Path) -> bool:
    if not python.is_file() or not os.access(python, os.X_OK):
        return False
    try:
        result = subprocess.run(  # noqa: S603 -- executable is locally configured
            [
                str(python.absolute()),
                "-I",
                "-c",
                "import importlib.util,sys; sys.exit(not all(importlib.util.find_spec(x) "
                "for x in ('kokoro_onnx','onnxruntime','numpy'))) ",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
        return result.returncode == 0
    except OSError, subprocess.TimeoutExpired:
        return False


def close_worker() -> None:
    global _worker, _worker_key
    worker, _worker = _worker, None
    _worker_key = None
    _clips.clear()
    if worker is None:
        return
    if worker.poll() is None:
        worker.kill()
    worker.wait()
    if worker.stdin:
        worker.stdin.close()
    if worker.stdout:
        worker.stdout.close()


def _start_worker(directory: Path, python: Path) -> subprocess.Popen[bytes]:
    global _worker, _worker_key
    key = (directory.resolve(), python.absolute())
    if _worker is not None and (_worker.poll() is not None or _worker_key != key):
        close_worker()
    if _worker is None:
        _worker = subprocess.Popen(  # noqa: S603 -- executable is locally configured
            [
                str(python.absolute()),
                str(Path(__file__).with_name("kokoro_worker.py")),
                str(key[0] / "kokoro"),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        _worker_key = key
    return _worker


def _read_exact(stream: Any, length: int) -> bytes:
    data = bytearray()
    while len(data) < length:
        chunk = stream.read(length - len(data))
        if not chunk:
            raise SpeechError
        data.extend(chunk)
    return bytes(data)


def _exchange(worker: subprocess.Popen[bytes], voice_id: str, text: str, rate: float) -> bytes:
    if worker.stdin is None or worker.stdout is None:
        raise SpeechError
    request = json.dumps({"voice": voice_id.removeprefix("kokoro-"), "text": text, "rate": rate})
    worker.stdin.write(request.encode("utf-8") + b"\n")
    worker.stdin.flush()
    size = struct.unpack("!I", _read_exact(worker.stdout, 4))[0]
    if not 0 < size <= MAX_WAV_BYTES:
        raise SpeechError
    return _read_exact(worker.stdout, size)


def synthesize(directory: Path, python: Path, voice_id: str, text: str, rate: float) -> bytes:
    if not _slot.acquire(blocking=False):
        raise SpeechBusy
    try:
        if voice_id not in VOICES or not runtime_available(python) or not installed(directory):
            raise SpeechError
        key = (directory.resolve(), python.absolute(), voice_id, rate, text)
        if key in _clips:
            _clips.move_to_end(key)
            return _clips[key]
        worker = _start_worker(directory, python)
        done = threading.Event()
        box: dict[str, Any] = {}

        def work() -> None:
            try:
                box["data"] = _exchange(worker, voice_id, text, rate)
            except Exception as exc:
                box["error"] = exc
            finally:
                done.set()

        thread = threading.Thread(target=work, name="lexicona-kokoro", daemon=True)
        thread.start()
        if not done.wait(TIMEOUT_SECONDS):
            close_worker()
            thread.join()
            raise SpeechTimeout
        if "error" in box:
            close_worker()
            raise SpeechError from box["error"]
        data = box.get("data")
        if not isinstance(data, bytes):
            raise SpeechError
        _validate_wav(data)
        _clips[key] = data
        while len(_clips) > 32:
            _clips.popitem(last=False)
        return data
    except SpeechError:
        raise
    except OSError, ValueError, EOFError, wave.Error:
        close_worker()
        raise SpeechError from None
    finally:
        _slot.release()


def _sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def download(directory: Path) -> None:
    root = directory / "kokoro"
    root.mkdir(parents=True, exist_ok=True)
    for name, (size, expected) in FILES.items():
        target = root / name
        if target.is_file() and target.stat().st_size == size and _sha256(target) == expected:
            continue
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile(dir=root, prefix=".kokoro-", delete=False) as output:
                temporary = output.name
                digest = hashlib.sha256()
                total = 0
                with urllib.request.urlopen(f"{MODEL_URL}/{name}", timeout=30) as response:  # noqa: S310 -- fixed URL
                    while chunk := response.read(1024 * 1024):
                        total += len(chunk)
                        if total > size:
                            raise SpeechError
                        digest.update(chunk)
                        output.write(chunk)
                if total != size or digest.hexdigest() != expected:
                    raise SpeechError
            os.replace(temporary, target)
        finally:
            if temporary is not None:
                Path(temporary).unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["download"])
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    try:
        download(args.output or Settings().tts_dir)
    except OSError, ValueError, SpeechError:
        raise SystemExit("Kokoro download failed; verify network and model checksums.") from None


if __name__ == "__main__":
    main()
