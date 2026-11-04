import argparse
import hashlib
import importlib.resources
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import wave
from pathlib import Path
from typing import Any

from lexicona.config import Settings

REVISION = "e7229f7d33a10e145e109b886d661984201ac3c4"
MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024
MAX_WAV_BYTES = 16 * 1024 * 1024
TIMEOUT_SECONDS = 30
_slot = threading.BoundedSemaphore(1)

VOICES = {
    "en_US-lessac-medium": ("Lessac", "en-US", "female"),
    "en_US-kristin-medium": ("Kristin", "en-US", "female"),
    "en_US-ryan-medium": ("Ryan", "en-US", "male"),
    "en_US-joe-medium": ("Joe", "en-US", "male"),
    "en_GB-alba-medium": ("Alba", "en-GB", "female"),
    "en_GB-jenny_dioco-medium": ("Jenny", "en-GB", "female"),
    "en_GB-alan-medium": ("Alan", "en-GB", "male"),
    "en_GB-northern_english_male-medium": ("Northern English", "en-GB", "male"),
    "ru_RU-denis-medium": ("Denis", "ru-RU", "male"),
    "ru_RU-dmitri-medium": ("Dmitri", "ru-RU", "male"),
}


class SpeechError(Exception):
    pass


class SpeechBusy(SpeechError):
    pass


class SpeechTimeout(SpeechError):
    pass


def installed(directory: Path, voice_id: str) -> bool:
    if voice_id not in VOICES:
        return False
    root = directory / voice_id
    try:
        return all(
            (root / filename).is_file() and (root / filename).stat().st_size > 0
            for filename in (f"{voice_id}.onnx", f"{voice_id}.onnx.json")
        )
    except OSError:
        return False


def voices(directory: Path) -> list[dict[str, str]]:
    return [
        {"id": voice_id, "name": name, "language": language, "gender": gender}
        for voice_id, (name, language, gender) in VOICES.items()
        if installed(directory, voice_id)
    ]


def runtime_available() -> bool:
    return importlib.util.find_spec("piper") is not None


def synthesize(directory: Path, voice_id: str, text: str, rate: float) -> bytes:
    if not _slot.acquire(blocking=False):
        raise SpeechBusy
    try:
        if not runtime_available() or not installed(directory, voice_id):
            raise SpeechError
        with tempfile.TemporaryDirectory(prefix="lexicona-tts-") as temp:
            output = Path(temp) / "speech.wav"
            input_file = Path(temp) / "input.txt"
            input_file.write_text(text, encoding="utf-8")
            cmd = [
                sys.executable,
                "-m",
                "piper",
                "-m",
                str(directory / voice_id / f"{voice_id}.onnx"),
                "-i",
                str(input_file),
                "-f",
                str(output),
                "--length-scale",
                str(1 / rate),
            ]
            try:
                child = subprocess.Popen(  # noqa: S603 -- fixed executable and allowlisted model
                    cmd,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except OSError:
                raise SpeechError from None
            try:
                deadline = time.monotonic() + TIMEOUT_SECONDS
                while child.poll() is None:
                    if time.monotonic() >= deadline:
                        raise SpeechTimeout
                    if output.exists() and output.stat().st_size > MAX_WAV_BYTES:
                        raise SpeechError
                    time.sleep(0.05)
                if (
                    child.returncode != 0
                    or not output.is_file()
                    or output.stat().st_size > MAX_WAV_BYTES
                ):
                    raise SpeechError
                data = output.read_bytes()
                with wave.open(io.BytesIO(data), "rb") as wav:
                    channels, width, frames = (
                        wav.getnchannels(),
                        wav.getsampwidth(),
                        wav.getnframes(),
                    )
                    if (
                        channels not in (1, 2)
                        or width not in (1, 2, 3, 4)
                        or wav.getframerate() <= 0
                        or frames <= 0
                        or len(wav.readframes(frames)) != frames * channels * width
                    ):
                        raise SpeechError
                return data
            except OSError, EOFError, wave.Error:
                raise SpeechError from None
            finally:
                if child.poll() is None:
                    child.kill()
                child.wait()
    except OSError, ValueError:
        raise SpeechError from None
    finally:
        _slot.release()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_file(url: str, target: Path, expected: str) -> None:
    if target.is_file() and _sha256(target) == expected:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".tts-", delete=False) as output:
            temporary = output.name
            digest = hashlib.sha256()
            total = 0
            with urllib.request.urlopen(url, timeout=30) as response:  # noqa: S310 -- fixed pinned URLs
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_DOWNLOAD_BYTES:
                        raise SpeechError
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != expected:
                raise SpeechError
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)


def download(directory: Path) -> None:
    manifest: dict[str, Any] = json.loads(
        importlib.resources.files("lexicona").joinpath("tts_manifest.json").read_text("utf-8")
    )
    if manifest["revision"] != REVISION or set(manifest["voices"]) != set(VOICES):
        raise SpeechError
    for voice_id, files in manifest["voices"].items():
        language, name, quality = voice_id.split("-")
        prefix = f"https://huggingface.co/rhasspy/piper-voices/resolve/{REVISION}/{language[:2]}/{language}/{name}/{quality}"
        for entry in files:
            filename = entry["file"]
            if filename not in (f"{voice_id}.onnx", f"{voice_id}.onnx.json", "MODEL_CARD"):
                raise SpeechError
            download_file(f"{prefix}/{filename}", directory / voice_id / filename, entry["sha256"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["download"])
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    try:
        download(args.output or Settings().tts_dir)
    except OSError, ValueError, SpeechError:
        raise SystemExit("Voice download failed; verify network and model checksums.") from None


if __name__ == "__main__":
    main()
