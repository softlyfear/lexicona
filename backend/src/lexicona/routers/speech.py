import asyncio
from typing import Annotated

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from lexicona import tts
from lexicona.deps import AppSettings, CurrentAuth

router = APIRouter(prefix="/speech", tags=["speech"])


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
        if value not in tts.VOICES:
            raise HTTPException(422, "invalid_voice")
        return value

    @field_validator("rate", mode="before")
    @classmethod
    def valid_rate(cls, value: object) -> object:
        if type(value) not in (int, float) or value not in (1, 0.75):
            raise ValueError("invalid rate")
        return value


@router.get("/voices")
async def list_voices(auth: CurrentAuth, settings: AppSettings) -> dict[str, object]:
    available_voices = tts.voices(settings.tts_dir)
    return {
        "voices": available_voices,
        "available": bool(available_voices) and tts.runtime_available(),
    }


@router.post("/synthesize")
async def synthesize(body: SpeechIn, auth: CurrentAuth, settings: AppSettings) -> Response:
    try:
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
