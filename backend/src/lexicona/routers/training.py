import random
from typing import Annotated, Literal, Self, cast

from fastapi import APIRouter, HTTPException, status
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StringConstraints,
    field_validator,
    model_validator,
)
from sqlalchemy import Select, case, func, or_, select, true, update
from sqlalchemy.sql.selectable import Exists

from lexicona import progress, srs
from lexicona.cloze import mask_example
from lexicona.db import utcnow
from lexicona.deps import CurrentAuth, Db
from lexicona.models import Tag, TrainingItem, TrainingSession, Word, WordProgress, WordTag
from lexicona.normalize import normalize
from lexicona.progress import AnswerKind
from lexicona.srs import Grade

router = APIRouter(prefix="/training", tags=["training"])

OPTION_COUNT = 6
_rng = random.SystemRandom()


class SessionIn(BaseModel):
    mode: Literal["choice", "input", "cards", "cloze"] = "choice"
    direction: Literal["en_ru", "ru_en", "en_en"] = "en_ru"
    purpose: Literal["scheduled", "free"] = "free"
    include_new: StrictBool = True
    size: Annotated[int, Field(ge=1, strict=True)] | Literal["all"] = 10
    tag_ids: list[Annotated[str, StringConstraints(min_length=1, max_length=32, strict=True)]] = (
        Field(default_factory=list, max_length=20)
    )
    progress_min: Annotated[int, Field(ge=0, strict=True)] | None = None
    progress_max: Annotated[int, Field(ge=0, strict=True)] | None = None

    @model_validator(mode="after")
    def valid_mode_direction(self) -> Self:
        if (self.mode == "cloze") != (self.direction == "en_en"):
            raise ValueError("invalid mode and direction combination")
        if (
            self.progress_min is not None
            and self.progress_max is not None
            and self.progress_max < self.progress_min
        ):
            raise ValueError("progress_max must be at least progress_min")
        return self


class ItemOut(BaseModel):
    id: str
    prompt: str
    options: list[str]


class SessionOut(BaseModel):
    id: str
    mode: str
    direction: str
    purpose: Literal["scheduled", "free"]
    items: list[ItemOut]


class AnswerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    option: int = Field(ge=0, strict=True)


class TextAnswerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(max_length=200, strict=True)

    @field_validator("text")
    @classmethod
    def valid_text(cls, value: str) -> str:
        if not normalize(value):
            raise ValueError("answer must not be blank")
        return value


class GradeAnswerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    grade: Grade


class AnswerOut(BaseModel):
    outcome: Literal["answered"] = "answered"
    correct: bool
    correct_option: int
    chosen_option: int
    delta: int
    progress: int


class TextAnswerOut(BaseModel):
    outcome: Literal["answered"] = "answered"
    correct: bool
    submitted_text: str
    expected_answers: list[str]
    delta: int
    progress: int


class RevealOut(BaseModel):
    outcome: Literal["revealed"] = "revealed"
    expected_answers: list[str]


class GradeAnswerOut(BaseModel):
    outcome: Literal["answered"] = "answered"
    grade: Grade
    expected_answers: list[str]
    delta: int
    progress: int


class AssistedOut(BaseModel):
    outcome: Literal["assisted"] = "assisted"
    expected_answers: list[str]
    delta: Literal[0] = 0
    progress: int


class ChoiceAssistedOut(AssistedOut):
    correct_option: int


class SkippedOut(BaseModel):
    outcome: Literal["skipped"] = "skipped"
    delta: Literal[0] = 0
    progress: int


class UnavailableOut(BaseModel):
    outcome: Literal["unavailable"] = "unavailable"
    reason: Literal["training_state_changed"] = "training_state_changed"
    delta: Literal[0] = 0
    progress: int


TerminalOut = (
    AnswerOut
    | TextAnswerOut
    | GradeAnswerOut
    | ChoiceAssistedOut
    | AssistedOut
    | SkippedOut
    | UnavailableOut
)


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
    tag_ids = set(body.tag_ids)
    if tag_ids:
        owned = (
            await db.scalars(
                select(Tag.id).where(Tag.owner_id == auth.user.id, Tag.id.in_(tag_ids))
            )
        ).all()
        if len(owned) != len(tag_ids):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "tag_not_found")

    pool = list(
        await db.scalars(
            select(Word).where(Word.owner_id == auth.user.id, Word.is_excluded.is_(False))
        )
    )
    matching_ids: set[str] | None = None
    if tag_ids:
        rows = await db.execute(
            select(WordTag.word_id)
            .where(WordTag.owner_id == auth.user.id, WordTag.tag_id.in_(tag_ids))
            .group_by(WordTag.word_id)
            .having(func.count(WordTag.tag_id) == len(tag_ids))
        )
        matching_ids = set(rows.scalars())
    filtered = [
        word
        for word in pool
        if (matching_ids is None or word.id in matching_ids)
        and (body.progress_min is None or word.progress >= body.progress_min)
        and (body.progress_max is None or word.progress <= body.progress_max)
    ]
    if (
        body.purpose == "free"
        and not filtered
        and (tag_ids or body.progress_min is not None or body.progress_max is not None)
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "no_matching_words")

    schedules = {
        schedule.word_id: schedule
        for schedule in await db.scalars(
            select(WordProgress).where(
                WordProgress.owner_id == auth.user.id,
                WordProgress.word_id.in_(word.id for word in filtered),
            )
        )
    }
    for word in filtered:
        if word.id not in schedules:
            # API-created and migrated words already have one; keep direct ORM fixtures valid too.
            schedules[word.id] = WordProgress(owner_id=auth.user.id, word_id=word.id)
            db.add(schedules[word.id])

    if body.purpose == "free":
        targets = _rng.sample(filtered, len(filtered))
    else:
        now = utcnow()
        due: list[Word] = []
        new: list[Word] = []
        for word in filtered:
            schedule = schedules[word.id]
            if not schedule.has_review:
                new.append(word)
            elif schedule.due_at is not None and schedule.due_at <= now:
                due.append(word)
        targets = _rng.sample(due, len(due))
        if body.include_new:
            targets += _rng.sample(new, len(new))[:10]
        if not targets:
            raise HTTPException(status.HTTP_409_CONFLICT, "no_scheduled_words")

    session = TrainingSession(
        owner_id=auth.user.id,
        mode=body.mode,
        direction=body.direction,
        purpose=body.purpose,
        difficulty=auth.user.difficulty,
    )
    for target in targets:
        if body.size != "all" and len(session.items) == body.size:
            break
        if body.mode == "choice":
            built = _build_item(target, pool, body.direction)
            if built is None:
                continue
            prompt, options, correct = built
            expected_answers = None
        elif body.mode == "cloze":
            masked = mask_example(target.headword, target.example_en)
            if masked is None:
                continue
            prompt = masked
            expected_answers = [target.headword]
            options = []
            correct = None
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
                word_training_version=target.training_version,
                word_progress_version=schedules[target.id].progress_version,
                position=len(session.items),
                prompt=prompt,
                options=options,
                correct_option=correct,
                expected_answers=expected_answers,
            )
        )
    if not session.items:
        detail = "no_eligible_cloze_examples" if body.mode == "cloze" else "not_enough_words"
        raise HTTPException(status.HTTP_409_CONFLICT, detail)

    db.add(session)
    await db.commit()
    return SessionOut(
        id=session.id,
        mode=session.mode,
        direction=session.direction,
        purpose=body.purpose,
        items=[ItemOut(id=i.id, prompt=i.prompt, options=i.options) for i in session.items],
    )


def _answer_out(item: TrainingItem, word_progress: int) -> TerminalOut:
    assert item.delta is not None
    if item.outcome == "unavailable":
        return UnavailableOut(progress=word_progress)
    if item.outcome == "skipped":
        return SkippedOut(progress=word_progress)
    if item.outcome == "assisted":
        if item.session.mode == "choice":
            assert item.correct_option is not None
            return ChoiceAssistedOut(
                expected_answers=[item.options[item.correct_option]],
                correct_option=item.correct_option,
                progress=word_progress,
            )
        assert item.expected_answers is not None
        return AssistedOut(expected_answers=item.expected_answers, progress=word_progress)
    assert item.outcome == "answered"
    if item.session.mode == "cards":
        assert item.grade is not None
        assert item.expected_answers is not None
        return GradeAnswerOut(
            grade=cast(Grade, item.grade),
            expected_answers=item.expected_answers,
            delta=item.delta,
            progress=word_progress,
        )
    assert item.is_correct is not None
    if item.session.mode in ("input", "cloze"):
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


async def _owned_item_and_word(
    item_id: str, auth: CurrentAuth, db: Db
) -> tuple[TrainingItem, Word]:
    item = await db.scalar(
        select(TrainingItem)
        .join(TrainingSession)
        .where(TrainingItem.id == item_id, TrainingSession.owner_id == auth.user.id)
    )
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "item_not_found")
    word = await db.scalar(
        select(Word).where(Word.id == item.word_id, Word.owner_id == auth.user.id)
    )
    if word is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "item_not_found")
    return item, word


def _owned_sessions(auth: CurrentAuth) -> Select[str]:
    return select(TrainingSession.id).where(TrainingSession.owner_id == auth.user.id)


def _eligible(auth: CurrentAuth) -> Exists:
    return (
        select(Word.id)
        .where(
            Word.id == TrainingItem.word_id,
            Word.owner_id == auth.user.id,
            Word.is_excluded.is_(False),
            Word.training_version == TrainingItem.word_training_version,
        )
        .exists()
    )


@router.post("/items/{item_id}/reveal")
async def reveal_item(item_id: str, auth: CurrentAuth, db: Db) -> RevealOut | TerminalOut:
    item, word = await _owned_item_and_word(item_id, auth, db)

    if item.outcome is not None:
        return _answer_out(item, word.progress)

    eligible = _eligible(auth)
    now = utcnow()
    if item.session.mode == "cards":
        await db.execute(
            update(TrainingItem)
            .where(
                TrainingItem.id == item.id,
                TrainingItem.session_id.in_(_owned_sessions(auth)),
                TrainingItem.outcome.is_(None),
            )
            .values(
                revealed_at=case(
                    (eligible, func.coalesce(TrainingItem.revealed_at, now)),
                    else_=TrainingItem.revealed_at,
                ),
                outcome=case((eligible, None), else_="unavailable"),
                delta=case((eligible, None), else_=0),
                answered_at=case((eligible, None), else_=now),
            )
        )
    else:
        await db.execute(
            update(TrainingItem)
            .where(
                TrainingItem.id == item.id,
                TrainingItem.session_id.in_(_owned_sessions(auth)),
                TrainingItem.outcome.is_(None),
            )
            .values(
                outcome=case((eligible, "assisted"), else_="unavailable"), delta=0, answered_at=now
            )
        )
    await db.commit()
    await db.refresh(item)
    await db.refresh(word)

    if item.outcome is not None:
        return _answer_out(item, word.progress)
    assert item.expected_answers is not None
    return RevealOut(expected_answers=item.expected_answers)


@router.post("/items/{item_id}/skip")
async def skip_item(item_id: str, auth: CurrentAuth, db: Db) -> TerminalOut:
    item, word = await _owned_item_and_word(item_id, auth, db)
    if item.outcome is None:
        await db.execute(
            update(TrainingItem)
            .where(
                TrainingItem.id == item.id,
                TrainingItem.session_id.in_(_owned_sessions(auth)),
                TrainingItem.outcome.is_(None),
            )
            .values(
                outcome=case((_eligible(auth), "skipped"), else_="unavailable"),
                delta=0,
                answered_at=utcnow(),
            )
        )
        await db.commit()
        await db.refresh(item)
        await db.refresh(word)
    return _answer_out(item, word.progress)


@router.post("/items/{item_id}/answer")
async def answer_item(
    item_id: str, body: AnswerIn | TextAnswerIn | GradeAnswerIn, auth: CurrentAuth, db: Db
) -> TerminalOut:
    item, word = await _owned_item_and_word(item_id, auth, db)

    if (
        (item.session.mode == "choice" and not isinstance(body, AnswerIn))
        or (item.session.mode in ("input", "cloze") and not isinstance(body, TextAnswerIn))
        or (item.session.mode == "cards" and not isinstance(body, GradeAnswerIn))
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_answer_for_mode")
    if isinstance(body, AnswerIn) and body.option >= len(item.options):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_option")
    if item.outcome is not None:
        return _answer_out(item, word.progress)
    if item.answered_at is None:
        if isinstance(body, AnswerIn):
            correct = body.option == item.correct_option
            kind = AnswerKind.CHOICE
            chosen_option = body.option
            submitted_text = None
            grade = "good" if correct else "again"
        elif isinstance(body, TextAnswerIn):
            assert item.expected_answers is not None
            correct = normalize(body.text) in {
                normalize(answer) for answer in item.expected_answers
            }
            kind = AnswerKind.TYPED
            chosen_option = None
            submitted_text = body.text
            grade = "good" if correct else "again"
        else:
            correct = None  # Card ratings are self-assessment, not objective answers.
            kind = AnswerKind.CHOICE
            chosen_option = None
            submitted_text = None
            grade = body.grade
        change = (
            0
            if grade == "hard"
            else progress.delta(
                item.session.difficulty, kind, correct if correct is not None else grade != "again"
            )
        )
        now = utcnow()
        # Check content and training eligibility in the same write transaction as the item CAS.
        current_version = (
            select(Word.content_version)
            .where(Word.id == item.word_id, Word.owner_id == auth.user.id)
            .scalar_subquery()
        )
        eligible = _eligible(auth)
        card_ready = (
            or_(~eligible, TrainingItem.revealed_at.is_not(None))
            if item.session.mode == "cards"
            else true()
        )
        # Of concurrent answers to one item only this conditional update can win.
        claimed = await db.execute(
            update(TrainingItem)
            .where(
                TrainingItem.id == item.id,
                TrainingItem.session_id.in_(_owned_sessions(auth)),
                TrainingItem.outcome.is_(None),
                card_ready,
            )
            .values(
                chosen_option=case((eligible, chosen_option), else_=None),
                submitted_text=case((eligible, submitted_text), else_=None),
                grade=case((eligible, grade), else_=None),
                is_correct=case((eligible, correct), else_=None),
                delta=case(
                    (eligible & (current_version == item.word_content_version), change), else_=0
                ),
                outcome=case((eligible, "answered"), else_="unavailable"),
                answered_at=now,
            )
        )
        if claimed.rowcount == 1:  # type: ignore[attr-defined]
            state = (
                await db.execute(
                    select(
                        Word.content_version,
                        Word.training_version,
                        Word.is_excluded,
                        WordProgress.stage,
                        WordProgress.success_streak,
                        WordProgress.review_count,
                        WordProgress.lapse_count,
                    )
                    .join(WordProgress, WordProgress.word_id == Word.id)
                    .where(
                        Word.id == item.word_id,
                        Word.owner_id == auth.user.id,
                        WordProgress.owner_id == auth.user.id,
                    )
                )
            ).one_or_none()
            current = (
                state is not None
                and not state[2]
                and state[0] == item.word_content_version
                and state[1] == item.word_training_version
            )
            if current:
                assert state is not None
                schedule_update = update(WordProgress).where(
                    WordProgress.owner_id == auth.user.id,
                    WordProgress.word_id == item.word_id,
                    WordProgress.progress_version == item.word_progress_version,
                )
                if item.session.purpose == "scheduled":
                    transition = srs.review(state[3], state[4], cast(Grade, grade), now)
                    changed = await db.execute(
                        schedule_update.values(
                            stage=transition.stage,
                            has_review=True,
                            due_at=transition.due_at,
                            last_review_at=now,
                            success_streak=transition.success_streak,
                            review_count=state[5] + 1,
                            lapse_count=state[6] + int(transition.is_lapse),
                            progress_version=item.word_progress_version + 1,
                        )
                    )
                else:
                    # Free practice changes only visible progress and the inter-session version.
                    changed = await db.execute(
                        schedule_update.values(progress_version=item.word_progress_version + 1)
                    )
                if changed.rowcount != 1:  # type: ignore[attr-defined]
                    await db.rollback()  # Also undo the item claim above.
                    raise HTTPException(status.HTTP_409_CONFLICT, "PROGRESS_CHANGED")
                applied = await db.execute(
                    update(Word)
                    .where(
                        Word.id == word.id,
                        Word.owner_id == auth.user.id,
                        Word.is_excluded.is_(False),
                        Word.training_version == item.word_training_version,
                        Word.content_version == item.word_content_version,
                    )
                    .values(progress=func.max(progress.MIN_PROGRESS, Word.progress + change))
                )
                if applied.rowcount != 1:  # type: ignore[attr-defined]
                    await db.rollback()
                    raise HTTPException(status.HTTP_409_CONFLICT, "PROGRESS_CHANGED")
        await db.commit()
        await db.refresh(item)
        await db.refresh(word)

    if item.outcome is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "card_not_revealed")
    # A repeated or concurrent answer returns the recorded result without changing anything.
    return _answer_out(item, word.progress)
