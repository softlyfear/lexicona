import random
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update

from lexicona import progress
from lexicona.db import utcnow
from lexicona.deps import CurrentAuth, Db
from lexicona.models import TrainingItem, TrainingSession, Word
from lexicona.progress import AnswerKind

router = APIRouter(prefix="/training", tags=["training"])

OPTION_COUNT = 4
_rng = random.SystemRandom()


class SessionIn(BaseModel):
    mode: Literal["choice"] = "choice"
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
    option: int = Field(ge=0, lt=OPTION_COUNT)


class AnswerOut(BaseModel):
    correct: bool
    correct_option: int
    chosen_option: int
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
        built = _build_item(target, pool, body.direction)
        if built is None:
            continue
        prompt, options, correct = built
        session.items.append(
            TrainingItem(
                word_id=target.id,
                word_content_version=target.content_version,
                position=len(session.items),
                prompt=prompt,
                options=options,
                correct_option=correct,
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


def _answer_out(item: TrainingItem, word_progress: int) -> AnswerOut:
    assert item.chosen_option is not None
    assert item.is_correct is not None
    assert item.delta is not None
    return AnswerOut(
        correct=item.is_correct,
        correct_option=item.correct_option,
        chosen_option=item.chosen_option,
        delta=item.delta,
        progress=word_progress,
    )


@router.post("/items/{item_id}/answer")
async def answer_item(item_id: str, body: AnswerIn, auth: CurrentAuth, db: Db) -> AnswerOut:
    item = await db.scalar(
        select(TrainingItem)
        .join(TrainingSession)
        .where(TrainingItem.id == item_id, TrainingSession.owner_id == auth.user.id)
    )
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "item_not_found")

    word = await db.get(Word, item.word_id)
    assert word is not None  # items are deleted together with their word

    if item.answered_at is None:
        correct = body.option == item.correct_option
        # An answer to a question about since-edited content teaches nothing about the new one.
        change = (
            progress.delta(item.session.difficulty, AnswerKind.CHOICE, correct)
            if word.content_version == item.word_content_version
            else 0
        )
        # Conditional update: of two concurrent answers only one is recorded.
        claimed = await db.execute(
            update(TrainingItem)
            .where(TrainingItem.id == item.id, TrainingItem.answered_at.is_(None))
            .values(
                chosen_option=body.option, is_correct=correct, delta=change, answered_at=utcnow()
            )
        )
        if claimed.rowcount == 1 and change:  # type: ignore[attr-defined]
            await db.execute(
                update(Word)
                .where(Word.id == word.id)
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
