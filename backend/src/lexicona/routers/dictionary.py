import asyncio
import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, StringConstraints

from lexicona import dictionary, translation
from lexicona.deps import AppSettings, CurrentAuth

router = APIRouter(prefix="/dictionary", tags=["dictionary"])


class LookupIn(BaseModel):
    headword: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class ExampleIn(LookupIn):
    previous_examples: list[
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    ] = Field(default_factory=list, max_length=20)


@router.post("/lookup")
async def lookup(body: LookupIn, auth: CurrentAuth, settings: AppSettings) -> dict[str, Any]:
    try:
        result = dictionary.lookup(settings.dictionary_path, body.headword)
    except OSError, sqlite3.Error, ValueError, TypeError, KeyError:
        result = None
    if result is not None and result["matches"]:
        return {**result, "machine_translation": None}
    try:
        machine = await asyncio.to_thread(translation.translate, settings, body.headword)
    except translation.TranslationError:
        raise HTTPException(503, "dictionary_unavailable") from None
    if result is None and machine is None:
        raise HTTPException(503, "dictionary_unavailable")
    return {
        **(result or {"source": dictionary.SOURCE, "matches": [], "spelling_suggestions": []}),
        "machine_translation": (
            {
                "provider": machine.provider,
                "text": machine.text,
                "alternatives": list(machine.alternatives),
                "transcription": machine.transcription,
            }
            if machine
            else None
        ),
    }


@router.post("/example")
async def example(body: ExampleIn, auth: CurrentAuth, settings: AppSettings) -> dict[str, str]:
    try:
        generated = await asyncio.to_thread(
            translation.generate_example, settings, body.headword, body.previous_examples
        )
    except translation.TranslationError:
        raise HTTPException(503, "examples_unavailable") from None
    if generated is None:
        raise HTTPException(503, "examples_unavailable")
    example_en, example_ru = generated
    return {"example_en": example_en, "example_ru": example_ru}


@router.get("/notices")
def notices(auth: CurrentAuth, settings: AppSettings) -> dict[str, Any]:
    try:
        return dictionary.notices(settings.dictionary_path)
    except OSError, sqlite3.Error, ValueError, TypeError, KeyError:
        raise HTTPException(503, "dictionary_unavailable") from None
