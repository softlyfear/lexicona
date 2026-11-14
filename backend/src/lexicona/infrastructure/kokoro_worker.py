"""Standalone worker executed in the Kokoro environment, not the backend environment."""

import contextlib
import importlib
import io
import json
import struct
import sys
import wave
from pathlib import Path


def main() -> None:
    root = Path(sys.argv[1])
    output = sys.stdout.buffer
    with contextlib.redirect_stdout(sys.stderr):
        np = importlib.import_module("numpy")
        ort = importlib.import_module("onnxruntime")
        kokoro = importlib.import_module("kokoro_onnx")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(
            str(root / "kokoro-v1.0.onnx"), options, providers=["CPUExecutionProvider"]
        )
        model = kokoro.Kokoro.from_session(session, str(root / "voices-v1.0.bin"))
    for line in sys.stdin.buffer:
        try:
            request = json.loads(line)
            voice = request["voice"]
            lang = "en-gb" if voice.startswith("b") else "en-us"
            with contextlib.redirect_stdout(sys.stderr):
                samples, sample_rate = model.create(
                    request["text"], voice=voice, speed=request["rate"], lang=lang
                )
            pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(sample_rate)
                audio.writeframes(pcm)
            data = buffer.getvalue()
        except Exception:
            data = b""
        output.write(struct.pack("!I", len(data)))
        output.write(data)
        output.flush()


if __name__ == "__main__":
    main()
