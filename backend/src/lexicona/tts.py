import argparse
import hashlib
import importlib.resources
import importlib.util
import io
import json
import os
import tempfile
import threading
import urllib.request
import wave
from collections import OrderedDict
from pathlib import Path
from typing import Any

from lexicona.config import Settings

REVISION = "e7229f7d33a10e145e109b886d661984201ac3c4"
MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024
MAX_WAV_BYTES = 16 * 1024 * 1024
TIMEOUT_SECONDS = 30
_slot = threading.BoundedSemaphore(1)
_LOADED_LIMIT = 2
_CLIP_LIMIT = 32
_loaded: OrderedDict[str, Any] = OrderedDict()
_clips: OrderedDict[tuple[str, float, str], bytes] = OrderedDict()

VOICES = {
    "en_US-lessac-medium": ("Lessac", "en-US", "female"),
    "en_US-kristin-medium": ("Kristin", "en-US", "female"),
    "en_US-ryan-medium": ("Ryan", "en-US", "male"),
    "en_US-joe-medium": ("Joe", "en-US", "male"),
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
    "en_GB-alba-medium": ("Alba", "en-GB", "female"),
    "en_GB-jenny_dioco-medium": ("Jenny", "en-GB", "female"),
    "en_GB-alan-medium": ("Alan", "en-GB", "male"),
    "en_GB-northern_english_male-medium": ("Northern English", "en-GB", "male"),
    "en_GB-cori-medium": ("Cori", "en-GB", "female"),
    "ru_RU-denis-medium": ("Denis", "ru-RU", "male"),
    "ru_RU-dmitri-medium": ("Dmitri", "ru-RU", "male"),
    "ru_RU-irina-medium": ("Irina", "ru-RU", "female"),
    "ru_RU-ruslan-medium": ("Ruslan", "ru-RU", "male"),
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


def reset_caches() -> None:
    _loaded.clear()
    _clips.clear()


def _validate_wav(data: bytes) -> None:
    if len(data) > MAX_WAV_BYTES:
        raise SpeechError
    with wave.open(io.BytesIO(data), "rb") as wav:
        channels, width, frames = wav.getnchannels(), wav.getsampwidth(), wav.getnframes()
        if (
            channels not in (1, 2)
            or width not in (1, 2, 3, 4)
            or wav.getframerate() <= 0
            or frames <= 0
            or len(wav.readframes(frames)) != frames * channels * width
        ):
            raise SpeechError


def _render(directory: Path, voice_id: str, text: str, rate: float) -> bytes:
    # The ONNX voice stays loaded. Starting Piper for every word reloads the model.
    from piper import PiperVoice, SynthesisConfig

    model = directory / voice_id / f"{voice_id}.onnx"
    key = str(model.resolve())
    voice = _loaded.get(key)
    if voice is None:
        voice = PiperVoice.load(model, use_cuda=False)
        _loaded[key] = voice
        while len(_loaded) > _LOADED_LIMIT:
            _loaded.popitem(last=False)
    else:
        _loaded.move_to_end(key)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        voice.synthesize_wav(text, wav, syn_config=SynthesisConfig(length_scale=1 / rate))
    return buffer.getvalue()


def synthesize(directory: Path, voice_id: str, text: str, rate: float) -> bytes:
    if not _slot.acquire(blocking=False):
        raise SpeechBusy
    handoff = False
    try:
        if not runtime_available() or not installed(directory, voice_id):
            raise SpeechError
        key = (voice_id, rate, text)
        cached = _clips.get(key)
        if cached is not None:
            _clips.move_to_end(key)
            return cached
        done = threading.Event()
        box: dict[str, Any] = {}

        def work() -> None:
            try:
                box["data"] = _render(directory, voice_id, text, rate)
            except Exception as exc:
                box["error"] = exc
            finally:
                done.set()

        threading.Thread(target=work, name="lexicona-tts", daemon=True).start()
        if not done.wait(TIMEOUT_SECONDS):
            handoff = True

            def release_later() -> None:
                done.wait()
                _slot.release()

            threading.Thread(target=release_later, name="lexicona-tts-release", daemon=True).start()
            raise SpeechTimeout
        if "error" in box:
            raise SpeechError from box["error"]
        data = box["data"]
        if not isinstance(data, bytes):
            raise SpeechError
        _validate_wav(data)
        _clips[key] = data
        while len(_clips) > _CLIP_LIMIT:
            _clips.popitem(last=False)
        return data
    except SpeechTimeout:
        raise
    except SpeechError:
        raise
    except OSError, ValueError, EOFError, wave.Error:
        raise SpeechError from None
    finally:
        if not handoff:
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
