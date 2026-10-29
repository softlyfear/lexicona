import random
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import case, func, select, update

from lexicona import progress
from lexicona.db import utcnow
from lexicona.deps import CurrentAuth, Db
from lexicona.models import TrainingItem, TrainingSession, Word
from lexicona.normalize import normalize
from lexicona.progress import AnswerKind

router = APIRouter(prefix="/training", tags=["training"])

OPTION_COUNT = 4
_rng = random.SystemRandom()


class SessionIn(BaseModel):
    mode: Literal["choice", "input"] = "choice"
    direction: Literal["en_ru", "ru_en"] = "en_ru"
    size: int = Field(default=10, ge=1, le=50)


class ItemOut(BaseModel):
    id: str
    prompt: str
    options: list[str]


class SessionOut(BaseModel):
    id: str
    mode: str
    direction: str
    items: list[ItemOut]


class AnswerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    option: int = Field(ge=0, lt=OPTION_COUNT, strict=True)


class TextAnswerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(max_length=200, strict=True)

    @field_validator("text")
    @classmethod
    def valid_text(cls, value: str) -> str:
        if not normalize(value):
            raise ValueError("answer must not be blank")
        return value


class AnswerOut(BaseModel):
    correct: bool
    correct_option: int
    chosen_option: int
    delta: int
    progress: int


class TextAnswerOut(BaseModel):
    correct: bool
    submitted_text: str
    expected_answers: list[str]
    delta: int
    progress: int


def _meanings(word: Word) -> set[str]:
    return {t.normalized_text for t in word.translations}


def _build_item(
    target: Word, pool: list[Word], direction: str
) -> tuple[str, list[str], int] | None:
    """Return (prompt, options, correct index), or None if no unambiguous distractors exist."""

    def shown(word: Word) -> tuple[str, str]:
        if direction == "en_ru":
            return word.translations[0].text, word.translations[0].normalized_text
        return word.headword, word.normalized_headword

    answer, answer_key = shown(target)
    seen = {answer_key}
    distractors: list[str] = []
    for other in _rng.sample(pool, len(pool)):
        # Skip anything that could also be a right answer for the target.
        if other.id == target.id or other.normalized_headword == target.normalized_headword:
            continue
        if _meanings(other) & _meanings(target):
            continue
        text, key = shown(other)
        if key in seen:
            continue
        seen.add(key)
        distractors.append(text)
        if len(distractors) == OPTION_COUNT - 1:
            break
    else:
        return None

    correct = _rng.randrange(OPTION_COUNT)
    options = [*distractors[:correct], answer, *distractors[correct:]]
    prompt = target.headword if direction == "en_ru" else target.translations[0].text
    return prompt, options, correct


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
async def create_session(body: SessionIn, auth: CurrentAuth, db: Db) -> SessionOut:
    pool = list(await db.scalars(select(Word).where(Word.owner_id == auth.user.id)))
    # Least-known words first; random order among equals.
    targets = sorted(_rng.sample(pool, len(pool)), key=lambda word: word.progress)

    session = TrainingSession(
        owner_id=auth.user.id,
        mode=body.mode,
        direction=body.direction,
        difficulty=auth.user.difficulty,
    )
    for target in targets:
        if len(session.items) == body.size:
            break
        if body.mode == "choice":
            built = _build_item(target, pool, body.direction)
            if built is None:
                continue
            prompt, options, correct = built
            expected_answers = None
        else:
            prompt = target.headword if body.direction == "en_ru" else target.translations[0].text
            expected_answers = (
                [translation.text for translation in target.translations]
                if body.direction == "en_ru"
                else [target.headword]
            )
            options = []
            correct = None
        session.items.append(
            TrainingItem(
                word_id=target.id,
                word_content_version=target.content_version,
                position=len(session.items),
                prompt=prompt,
                options=options,
                correct_option=correct,
                expected_answers=expected_answers,
            )
        )
    if not session.items:
        raise HTTPException(status.HTTP_409_CONFLICT, "not_enough_words")

    db.add(session)
    await db.commit()
    return SessionOut(
        id=session.id,
        mode=session.mode,
        direction=session.direction,
        items=[ItemOut(id=i.id, prompt=i.prompt, options=i.options) for i in session.items],
    )


def _answer_out(item: TrainingItem, word_progress: int) -> AnswerOut | TextAnswerOut:
    assert item.is_correct is not None
    assert item.delta is not None
    if item.session.mode == "input":
        assert item.submitted_text is not None
        assert item.expected_answers is not None
        return TextAnswerOut(
            correct=item.is_correct,
            submitted_text=item.submitted_text,
            expected_answers=item.expected_answers,
            delta=item.delta,
            progress=word_progress,
        )
    assert item.correct_option is not None
    assert item.chosen_option is not None
    return AnswerOut(
        correct=item.is_correct,
        correct_option=item.correct_option,
        chosen_option=item.chosen_option,
        delta=item.delta,
        progress=word_progress,
    )


@router.post("/items/{item_id}/answer")
async def answer_item(
    item_id: str, body: AnswerIn | TextAnswerIn, auth: CurrentAuth, db: Db
) -> AnswerOut | TextAnswerOut:
    item = await db.scalar(
        select(TrainingItem)
        .join(TrainingSession)
        .where(TrainingItem.id == item_id, TrainingSession.owner_id == auth.user.id)
    )
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "item_not_found")

    if (item.session.mode == "choice" and not isinstance(body, AnswerIn)) or (
        item.session.mode == "input" and not isinstance(body, TextAnswerIn)
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_answer_for_mode")

    word = await db.scalar(
        select(Word).where(Word.id == item.word_id, Word.owner_id == auth.user.id)
    )
    if word is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "item_not_found")

    if item.answered_at is None:
        if isinstance(body, AnswerIn):
            correct = body.option == item.correct_option
            kind = AnswerKind.CHOICE
            chosen_option = body.option
            submitted_text = None
        else:
            assert item.expected_answers is not None
            correct = normalize(body.text) in {
                normalize(answer) for answer in item.expected_answers
            }
            kind = AnswerKind.TYPED
            chosen_option = None
            submitted_text = body.text
        change = progress.delta(item.session.difficulty, kind, correct)
        # Check the version in the write transaction, not against a potentially stale read.
        current_version = (
            select(Word.content_version).where(Word.id == item.word_id).scalar_subquery()
        )
        # Conditional update: of two concurrent answers only one is recorded.
        claimed = await db.execute(
            update(TrainingItem)
            .where(TrainingItem.id == item.id, TrainingItem.answered_at.is_(None))
            .values(
                chosen_option=chosen_option,
                submitted_text=submitted_text,
                is_correct=correct,
                delta=case((current_version == item.word_content_version, change), else_=0),
                answered_at=utcnow(),
            )
        )
        if claimed.rowcount == 1 and change:  # type: ignore[attr-defined]
            await db.execute(
                update(Word)
                .where(Word.id == word.id, Word.content_version == item.word_content_version)
                .values(
                    progress=func.max(
                        progress.MIN_PROGRESS,
                        func.min(progress.MAX_PROGRESS, Word.progress + change),
                    )
                )
            )
        await db.commit()
        await db.refresh(item)
        await db.refresh(word)

    # A repeated or concurrent answer returns the recorded result without changing anything.
    return _answer_out(item, word.progress)
