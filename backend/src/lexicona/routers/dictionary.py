import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, StringConstraints

from lexicona import dictionary
from lexicona.deps import AppSettings, CurrentAuth

router = APIRouter(prefix="/dictionary", tags=["dictionary"])


class LookupIn(BaseModel):
    headword: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


@router.post("/lookup")
def lookup(body: LookupIn, auth: CurrentAuth, settings: AppSettings) -> dict[str, Any]:
    try:
        return dictionary.lookup(settings.dictionary_path, body.headword)
    except OSError, sqlite3.Error, ValueError, TypeError, KeyError:
        raise HTTPException(503, "dictionary_unavailable") from None


@router.get("/notices")
def notices(auth: CurrentAuth, settings: AppSettings) -> dict[str, Any]:
    try:
        return dictionary.notices(settings.dictionary_path)
    except OSError, sqlite3.Error, ValueError, TypeError, KeyError:
        raise HTTPException(503, "dictionary_unavailable") from None
