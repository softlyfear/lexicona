import asyncio
import sqlite3
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, StringConstraints

from lexicona.infrastructure import dictionary, translation
from lexicona.interfaces.http.deps import AppSettings, CurrentAuth

router = APIRouter(prefix="/dictionary", tags=["dictionary"])


class LookupIn(BaseModel):
    headword: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class ExampleIn(LookupIn):
    previous_examples: list[
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    ] = Field(default_factory=list, max_length=20)


class TranslationsOut(BaseModel):
    provider: Literal["openrouter"] = "openrouter"
    translations: list[Annotated[str, StringConstraints(min_length=1, max_length=200)]] = Field(
        min_length=1, max_length=5
    )


def _machine_payload(machine: translation.MachineTranslation | None) -> dict[str, Any] | None:
    if machine is None:
        return None
    return {
        "provider": machine.provider,
        "text": machine.text,
        "alternatives": list(machine.alternatives),
        "transcription": machine.transcription,
    }


async def _generated_transcription(settings: AppSettings, headword: str) -> str | None:
    try:
        return await asyncio.to_thread(translation.transcribe, settings, headword)
    except translation.TranslationError:
        return None


@router.post("/lookup")
async def lookup(body: LookupIn, auth: CurrentAuth, settings: AppSettings) -> dict[str, Any]:
    if not settings.dictionary_path.is_file():
        # The optional local index is not installed; the machine provider is the hint.
        result = None
    else:
        try:
            result = await asyncio.to_thread(
                dictionary.lookup, settings.dictionary_path, body.headword
            )
        except sqlite3.Error, ValueError, TypeError, KeyError:
            # A present but broken index must not look like a normal miss: that would
            # hide a broken deployment and silently spend paid provider calls.
            raise HTTPException(503, "dictionary_unavailable") from None
    if result is not None and result["matches"]:
        generated = None
        if not any(match["transcriptions"] for match in result["matches"]):
            generated = await _generated_transcription(settings, body.headword)
        return {**result, "machine_translation": None, "machine_transcription": generated}
    try:
        machine = await asyncio.to_thread(translation.translate, settings, body.headword)
    except translation.TranslationTimeout:
        raise HTTPException(504, "dictionary_timeout") from None
    except translation.TranslationError:
        raise HTTPException(503, "dictionary_unavailable") from None
    if result is None and machine is None:
        raise HTTPException(503, "dictionary_unavailable")
    if machine is not None and not machine.transcription:
        generated = await _generated_transcription(settings, body.headword)
        if generated:
            machine = translation.MachineTranslation(
                machine.provider, machine.text, machine.alternatives, generated
            )
    return {
        **(result or {"source": dictionary.SOURCE, "matches": [], "spelling_suggestions": []}),
        "machine_translation": _machine_payload(machine),
        "machine_transcription": None,
    }


@router.post("/example")
async def example(body: ExampleIn, auth: CurrentAuth, settings: AppSettings) -> dict[str, str]:
    try:
        generated = await asyncio.to_thread(
            translation.generate_example, settings, body.headword, body.previous_examples
        )
    except translation.TranslationTimeout:
        raise HTTPException(504, "examples_timeout") from None
    except translation.TranslationError:
        raise HTTPException(503, "examples_unavailable") from None
    if generated is None:
        raise HTTPException(503, "examples_unavailable")
    example_en, example_ru = generated
    return {"example_en": example_en, "example_ru": example_ru}


@router.post("/transcription")
async def transcription(body: LookupIn, auth: CurrentAuth, settings: AppSettings) -> dict[str, str]:
    try:
        generated = await asyncio.to_thread(translation.transcribe, settings, body.headword)
    except translation.TranslationTimeout:
        raise HTTPException(504, "transcription_timeout") from None
    except translation.TranslationError:
        raise HTTPException(503, "transcription_unavailable") from None
    if not generated:
        raise HTTPException(503, "transcription_unavailable")
    return {"transcription": generated}


@router.post("/translations")
async def translations(body: LookupIn, auth: CurrentAuth, settings: AppSettings) -> TranslationsOut:
    try:
        generated = await asyncio.to_thread(
            translation.generate_translations, settings, body.headword
        )
    except translation.TranslationTimeout:
        raise HTTPException(504, "translations_timeout") from None
    except translation.TranslationError:
        raise HTTPException(503, "translations_unavailable") from None
    if not generated:
        raise HTTPException(503, "translations_unavailable")
    return TranslationsOut(translations=generated)


@router.get("/notices")
def notices(auth: CurrentAuth, settings: AppSettings) -> dict[str, Any]:
    try:
        return dictionary.notices(settings.dictionary_path)
    except OSError, sqlite3.Error, ValueError, TypeError, KeyError:
        raise HTTPException(503, "dictionary_unavailable") from None
