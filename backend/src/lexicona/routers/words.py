import unicodedata
from datetime import datetime
from typing import Annotated, Any, Literal, Self

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StringConstraints,
    field_validator,
    model_validator,
)
from sqlalchemy import ColumnElement, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from lexicona.deps import CurrentAuth, Db
from lexicona.models import Tag, Word, WordProgress, WordTag, WordTranslation
from lexicona.normalize import normalize
from lexicona.tags import TagOut, replace_tags, tag_key, tag_name, tags_for_words

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


class SourceRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_id: Literal["freedict-wikdict-eng-rus-2025.11.23"]
    entry_id: Annotated[int, Field(strict=True, gt=0)]
    field: Literal["translation", "transcription"]
    value: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]


def ref_key(value: str) -> str:
    return unicodedata.normalize("NFC", value.strip())


class WordIn(BaseModel):
    headword: Text200
    translations: list[Text200] = Field(min_length=1, max_length=10)
    transcription: Annotated[Text300 | None, Blank] = None
    example_en: Annotated[Text2000 | None, Blank] = None
    example_ru: Annotated[Text2000 | None, Blank] = None
    note: Annotated[Text4000 | None, Blank] = None
    tags: list[str] = Field(default_factory=list, max_length=20)
    source_refs: list[SourceRef] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def valid_refs(self) -> Self:
        allowed = {ref_key(value) for value in self.translations}
        transcription = ref_key(self.transcription) if self.transcription else None
        if any(
            (
                ref_key(ref.value) not in allowed
                if ref.field == "translation"
                else ref_key(ref.value) != transcription
            )
            for ref in self.source_refs
        ):
            raise ValueError("source refs must match current field values")
        return self

    @field_validator("tags")
    @classmethod
    def valid_tags(cls, value: list[str]) -> list[str]:
        names = [tag_name(name) for name in value]
        if any(not name or len(name) > 80 for name in names):
            raise ValueError("tag names must contain 1..80 characters")
        if len({tag_key(name) for name in names}) != len(names):
            raise ValueError("tags must be unique")
        return names

    @field_validator("translations")
    @classmethod
    def unique_translations(cls, value: list[str]) -> list[str]:
        if len({normalize(text) for text in value}) != len(value):
            raise ValueError("translations must be unique")
        return value


class WordOut(BaseModel):
    id: str
    tags: list[TagOut]
    headword: str
    source_refs: list[SourceRef]
    translations: list[str]
    transcription: str | None
    example_en: str | None
    example_ru: str | None
    note: str | None
    progress: int
    is_excluded: bool
    is_learned: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def of(cls, word: Word, tags: list[TagOut]) -> WordOut:
        return cls(
            id=word.id,
            tags=tags,
            headword=word.headword,
            source_refs=word.source_refs or [],
            translations=[t.text for t in word.translations],
            transcription=word.transcription,
            example_en=word.example_en,
            example_ru=word.example_ru,
            note=word.note,
            progress=word.progress,
            is_excluded=word.is_excluded,
            is_learned=word.is_learned,
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
    candidates = (
        [ref.model_dump() for ref in body.source_refs]
        if "source_refs" in body.model_fields_set
        else (word.source_refs or [])
    )
    translations = {ref_key(value) for value in body.translations}
    transcription = ref_key(body.transcription) if body.transcription else None
    surviving: list[dict[str, object]] = []
    for ref in candidates:
        value = ref_key(str(ref["value"]))
        if (
            value in translations if ref["field"] == "translation" else value == transcription
        ) and ref not in surviving:
            surviving.append(ref)
    word.source_refs = surviving or None
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
    training: Literal["active", "excluded", "learned", "all"] = "active",
    tag_id: Annotated[
        list[Annotated[str, Query(min_length=1, max_length=32)]] | None, Query(max_length=20)
    ] = None,
) -> list[WordOut]:
    query = select(Word).where(Word.owner_id == auth.user.id)
    ids = set(tag_id or [])
    if ids:
        count = len(
            (
                await db.scalars(
                    select(Tag.id).where(Tag.owner_id == auth.user.id, Tag.id.in_(ids))
                )
            ).all()
        )
        if count != len(ids):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "tag_not_found")
        query = query.where(
            select(WordTag.word_id)
            .where(
                WordTag.owner_id == auth.user.id,
                WordTag.word_id == Word.id,
                WordTag.tag_id.in_(ids),
            )
            .exists()
        )
    # Learned is an explicit mark and does not depend on progress or exclusion.
    if training == "learned":
        query = query.where(Word.is_learned.is_(True))
    elif training != "all":
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
    words = (await db.scalars(query.order_by(ordering[sort], Word.id.asc()))).all()
    word_tags = await tags_for_words(db, auth.user.id, [word.id for word in words])
    return [WordOut.of(word, word_tags.get(word.id, [])) for word in words]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_word(body: WordIn, auth: CurrentAuth, db: Db) -> WordOut:
    word = Word(owner_id=auth.user.id)
    _fill(word, body)
    db.add(word)
    await db.flush()
    db.add(WordProgress(owner_id=auth.user.id, word_id=word.id))
    await replace_tags(db, auth.user.id, word.id, body.tags)
    await db.commit()
    return await word_out(db, auth.user.id, word)


async def word_out(db: AsyncSession, owner_id: str, word: Word) -> WordOut:
    tags = await tags_for_words(db, owner_id, [word.id])
    return WordOut.of(word, tags.get(word.id, []))


@router.get("/{word_id}")
async def get_word(word_id: str, auth: CurrentAuth, db: Db) -> WordOut:
    return await word_out(db, auth.user.id, await owned_word(db, auth.user.id, word_id))


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
    return await word_out(db, auth.user.id, word)


class LearnedStateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_learned: StrictBool


@router.patch("/{word_id}/learned")
async def set_learned_state(
    word_id: str, body: LearnedStateIn, auth: CurrentAuth, db: Db
) -> WordOut:
    # Reversible and independent of progress, meaning, and open training items.
    word = await owned_word(db, auth.user.id, word_id)
    await db.execute(
        update(Word)
        .where(
            Word.id == word_id,
            Word.owner_id == auth.user.id,
            Word.is_learned.is_not(body.is_learned),
        )
        .values(is_learned=body.is_learned)
    )
    await db.commit()
    await db.refresh(word)
    return await word_out(db, auth.user.id, word)


@router.put("/{word_id}")
async def update_word(word_id: str, body: WordIn, auth: CurrentAuth, db: Db) -> WordOut:
    word = await owned_word(db, auth.user.id, word_id)
    meaning_before = (word.normalized_headword, [t.normalized_text for t in word.translations])
    _fill(word, body)
    meaning_after = (word.normalized_headword, [t.normalized_text for t in word.translations])
    if meaning_before != meaning_after:
        # A different word or meaning is a new thing to learn, with a monotonic version.
        word.progress = 0
        word.content_version += 1
        reset = await db.execute(
            update(WordProgress)
            .where(WordProgress.owner_id == auth.user.id, WordProgress.word_id == word.id)
            .values(
                stage=0,
                has_review=False,
                due_at=None,
                last_review_at=None,
                success_streak=0,
                review_count=0,
                lapse_count=0,
                progress_version=WordProgress.progress_version + 1,
            )
        )
        if reset.rowcount == 0:  # type: ignore[attr-defined]
            db.add(
                WordProgress(
                    owner_id=auth.user.id, word_id=word.id, progress_version=word.content_version
                )
            )
    if "tags" in body.model_fields_set:
        await replace_tags(db, auth.user.id, word.id, body.tags)
    await db.commit()
    return await word_out(db, auth.user.id, word)


@router.delete("/{word_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_word(word_id: str, auth: CurrentAuth, db: Db) -> None:
    await db.delete(await owned_word(db, auth.user.id, word_id))
    await db.commit()
