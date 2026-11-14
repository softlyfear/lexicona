import asyncio
from typing import Annotated

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from lexicona.infrastructure import kokoro, tts
from lexicona.interfaces.http.deps import AppSettings, CurrentAuth

router = APIRouter(prefix="/speech", tags=["speech"])
SPEECH_RATES = (0.5, 0.75, 1, 1.25, 1.5)


class SpeechIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: Annotated[
        str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=2000)
    ]
    voice_id: str = Field(strict=True)
    rate: float

    @field_validator("text", mode="before")
    @classmethod
    def text_limit(cls, value: object) -> object:
        if not isinstance(value, str) or len(value) > 2000:
            raise ValueError("invalid text")
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raise HTTPException(422, "invalid_text") from None
        return value

    @field_validator("voice_id")
    @classmethod
    def known_voice(cls, value: str) -> str:
        if value not in tts.VOICES and value not in kokoro.VOICES:
            raise HTTPException(422, "invalid_voice")
        return value

    @field_validator("rate", mode="before")
    @classmethod
    def valid_rate(cls, value: object) -> object:
        if type(value) not in (int, float) or value not in SPEECH_RATES:
            raise ValueError("invalid rate")
        return value


@router.get("/voices")
async def list_voices(auth: CurrentAuth, settings: AppSettings) -> dict[str, object]:
    if settings.tts_engine == "kokoro":
        available_voices = kokoro.voices(settings.tts_dir)
        available = bool(available_voices) and await asyncio.to_thread(
            kokoro.runtime_available, settings.kokoro_python
        )
        return {
            "voices": available_voices,
            "available": available,
        }
    available_voices = tts.voices(settings.tts_dir)
    return {
        "voices": available_voices,
        "available": bool(available_voices) and tts.runtime_available(),
    }


@router.post("/synthesize")
async def synthesize(body: SpeechIn, auth: CurrentAuth, settings: AppSettings) -> Response:
    try:
        if settings.tts_engine == "kokoro":
            if body.voice_id not in kokoro.VOICES:
                raise HTTPException(422, "invalid_voice")
            data = await asyncio.to_thread(
                kokoro.synthesize,
                settings.tts_dir,
                settings.kokoro_python,
                body.voice_id,
                body.text,
                float(body.rate),
            )
        else:
            if body.voice_id not in tts.VOICES:
                raise HTTPException(422, "invalid_voice")
            data = await asyncio.to_thread(
                tts.synthesize, settings.tts_dir, body.voice_id, body.text, float(body.rate)
            )
    except tts.SpeechBusy:
        raise HTTPException(503, "speech_busy") from None
    except tts.SpeechTimeout:
        raise HTTPException(504, "speech_timeout") from None
    except tts.SpeechError:
        raise HTTPException(503, "speech_unavailable") from None
    return Response(data, media_type="audio/wav")
