from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StringConstraints,
    field_validator,
)
from sqlalchemy import ColumnElement, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from lexicona.deps import CurrentAuth, Db
from lexicona.models import Word, WordTranslation
from lexicona.normalize import normalize

router = APIRouter(prefix="/words", tags=["words"])


def _blank_to_none(value: str | None) -> str | None:
    return value or None


Text200 = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Text300 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)]
Text2000 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
Text4000 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)]
Blank = AfterValidator(_blank_to_none)
WordSort = Literal[
    "created_desc", "created_asc", "headword_asc", "headword_desc", "progress_asc", "progress_desc"
]


class WordIn(BaseModel):
    headword: Text200
    translations: list[Text200] = Field(min_length=1, max_length=10)
    transcription: Annotated[Text300 | None, Blank] = None
    example_en: Annotated[Text2000 | None, Blank] = None
    example_ru: Annotated[Text2000 | None, Blank] = None
    note: Annotated[Text4000 | None, Blank] = None

    @field_validator("translations")
    @classmethod
    def unique_translations(cls, value: list[str]) -> list[str]:
        if len({normalize(text) for text in value}) != len(value):
            raise ValueError("translations must be unique")
        return value


class WordOut(BaseModel):
    id: str
    headword: str
    translations: list[str]
    transcription: str | None
    example_en: str | None
    example_ru: str | None
    note: str | None
    progress: int
    is_excluded: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def of(cls, word: Word) -> WordOut:
        return cls(
            id=word.id,
            headword=word.headword,
            translations=[t.text for t in word.translations],
            transcription=word.transcription,
            example_en=word.example_en,
            example_ru=word.example_ru,
            note=word.note,
            progress=word.progress,
            is_excluded=word.is_excluded,
            created_at=word.created_at,
            updated_at=word.updated_at,
        )


async def owned_word(db: AsyncSession, owner_id: str, word_id: str) -> Word:
    word = await db.scalar(select(Word).where(Word.id == word_id, Word.owner_id == owner_id))
    if word is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "word_not_found")
    return word


def _fill(word: Word, body: WordIn) -> None:
    word.headword = body.headword
    word.normalized_headword = normalize(body.headword)
    word.transcription = body.transcription
    word.example_en = body.example_en
    word.example_ru = body.example_ru
    word.note = body.note
    # Update rows in place: replacing them would clash on the (word_id, position) key.
    rows = word.translations
    for position, text in enumerate(body.translations):
        if position < len(rows):
            rows[position].text = text
            rows[position].normalized_text = normalize(text)
        else:
            rows.append(
                WordTranslation(position=position, text=text, normalized_text=normalize(text))
            )
    del rows[len(body.translations) :]


@router.get("")
async def list_words(
    auth: CurrentAuth,
    db: Db,
    q: Annotated[str, Query(max_length=200)] = "",
    sort: WordSort = "created_desc",
    training: Literal["active", "excluded", "all"] = "active",
) -> list[WordOut]:
    query = select(Word).where(Word.owner_id == auth.user.id)
    if training != "all":
        query = query.where(Word.is_excluded.is_(training == "excluded"))
    if needle := normalize(q):
        pattern = "%" + needle.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_") + "%"
        query = query.where(
            or_(
                Word.normalized_headword.like(pattern, escape="\\"),
                Word.translations.any(WordTranslation.normalized_text.like(pattern, escape="\\")),
            )
        )
    ordering: dict[WordSort, ColumnElement[Any]] = {
        "created_desc": Word.created_at.desc(),
        "created_asc": Word.created_at.asc(),
        "headword_asc": Word.normalized_headword.asc(),
        "headword_desc": Word.normalized_headword.desc(),
        "progress_asc": Word.progress.asc(),
        "progress_desc": Word.progress.desc(),
    }
    words = await db.scalars(query.order_by(ordering[sort], Word.id.asc()))
    return [WordOut.of(word) for word in words]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_word(body: WordIn, auth: CurrentAuth, db: Db) -> WordOut:
    word = Word(owner_id=auth.user.id)
    _fill(word, body)
    db.add(word)
    await db.commit()
    return WordOut.of(word)


@router.get("/{word_id}")
async def get_word(word_id: str, auth: CurrentAuth, db: Db) -> WordOut:
    return WordOut.of(await owned_word(db, auth.user.id, word_id))


class TrainingStateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_excluded: StrictBool


@router.patch("/{word_id}/training")
async def set_training_state(
    word_id: str, body: TrainingStateIn, auth: CurrentAuth, db: Db
) -> WordOut:
    word = await owned_word(db, auth.user.id, word_id)
    await db.execute(
        update(Word)
        .where(
            Word.id == word_id,
            Word.owner_id == auth.user.id,
            Word.is_excluded.is_not(body.is_excluded),
        )
        .values(is_excluded=body.is_excluded, training_version=Word.training_version + 1)
    )
    await db.commit()
    await db.refresh(word)
    return WordOut.of(word)


@router.put("/{word_id}")
async def update_word(word_id: str, body: WordIn, auth: CurrentAuth, db: Db) -> WordOut:
    word = await owned_word(db, auth.user.id, word_id)
    meaning_before = (word.normalized_headword, [t.normalized_text for t in word.translations])
    _fill(word, body)
    meaning_after = (word.normalized_headword, [t.normalized_text for t in word.translations])
    if meaning_before != meaning_after:
        # A different word or meaning is a new thing to learn.
        word.progress = 0
        word.content_version += 1
    await db.commit()
    return WordOut.of(word)


@router.delete("/{word_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_word(word_id: str, auth: CurrentAuth, db: Db) -> None:
    await db.delete(await owned_word(db, auth.user.id, word_id))
    await db.commit()
