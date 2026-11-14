import random
from datetime import datetime
from typing import Annotated, Any, Literal, Self, cast

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

from lexicona.domain import distractors, progress, srs
from lexicona.domain.normalize import hinted_text, normalize
from lexicona.domain.progress import AnswerKind
from lexicona.domain.srs import Grade
from lexicona.infrastructure import dictionary
from lexicona.infrastructure.db import utcnow
from lexicona.infrastructure.models import (
    AnswerEvent,
    Tag,
    TrainingItem,
    TrainingSession,
    Word,
    WordProgress,
    WordTag,
)
from lexicona.interfaces.http.deps import CurrentAuth, Db

router = APIRouter(prefix="/training", tags=["training"])

OPTION_COUNT = 6
_rng = random.SystemRandom()


class SessionIn(BaseModel):
    mode: Literal["choice", "input", "matching"] = "choice"
    direction: Literal["en_ru", "ru_en", "en_en"] = "en_ru"
    purpose: Literal["scheduled", "free"] = "free"
    include_new: StrictBool = True
    size: Annotated[int, Field(ge=1, strict=True)] | Literal["all"] = 10
    tag_ids: list[Annotated[str, StringConstraints(min_length=1, max_length=32, strict=True)]] = (
        Field(default_factory=list, max_length=20)
    )
    progress_min: Annotated[int, Field(ge=0, strict=True)] | None = None
    progress_max: Annotated[int, Field(ge=0, strict=True)] | None = None
    order: Literal[
        "random",
        "reviewed_desc",
        "reviewed_asc",
        "created_desc",
        "created_asc",
        "progress_asc",
        "progress_desc",
    ] = "random"
    shuffle: StrictBool = False
    selection_seed: (
        Annotated[str, StringConstraints(pattern=r"^[0-9a-fA-F]{32}$", strict=True)] | None
    ) = None

    @model_validator(mode="after")
    def valid_mode_direction(self) -> Self:
        if self.direction == "en_en" or (self.mode == "matching" and self.direction != "en_ru"):
            raise ValueError("invalid mode and direction combination")
        if (
            self.progress_min is not None
            and self.progress_max is not None
            and self.progress_max < self.progress_min
        ):
            raise ValueError("progress_max must be at least progress_min")
        return self


class PreviewOut(BaseModel):
    count: int
    selection_seed: str
    unavailable_reason: (
        Literal["no_matching_words", "no_scheduled_words", "not_enough_words"] | None
    )


class ItemOut(BaseModel):
    id: str
    prompt: str
    options: list[str]
    transcription: str | None = None
    word_id: str | None = None


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


class LetterHintIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(default="", max_length=200, strict=True)


class LetterHintOut(BaseModel):
    text: str
    complete: bool


class GradeAnswerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    grade: Grade


class AnswerOut(BaseModel):
    outcome: Literal["answered"] = "answered"
    correct: bool
    correct_option: int
    chosen_option: int
    delta: int
    progress: int | None


class TextAnswerOut(BaseModel):
    outcome: Literal["answered"] = "answered"
    correct: bool
    submitted_text: str
    expected_answers: list[str]
    delta: int
    progress: int | None


class RevealOut(BaseModel):
    outcome: Literal["revealed"] = "revealed"
    expected_answers: list[str]


class GradeAnswerOut(BaseModel):
    outcome: Literal["answered"] = "answered"
    grade: Grade
    expected_answers: list[str]
    delta: int
    progress: int | None


class AssistedOut(BaseModel):
    outcome: Literal["assisted"] = "assisted"
    expected_answers: list[str]
    delta: Literal[0] = 0
    progress: int | None


class ChoiceAssistedOut(AssistedOut):
    correct_option: int


class SkippedOut(BaseModel):
    outcome: Literal["skipped"] = "skipped"
    delta: Literal[0] = 0
    progress: int | None


class UnavailableOut(BaseModel):
    outcome: Literal["unavailable"] = "unavailable"
    reason: Literal["training_state_changed", "word_deleted"] = "training_state_changed"
    delta: Literal[0] = 0
    progress: int | None


TerminalOut = (
    AnswerOut
    | TextAnswerOut
    | GradeAnswerOut
    | ChoiceAssistedOut
    | AssistedOut
    | SkippedOut
    | UnavailableOut
)


ChoiceCandidate = Word | dictionary.ChoiceEntry


def _choice_key(value: str) -> str:
    return value.replace("\u0301", "")


def _meanings(word: ChoiceCandidate) -> set[str]:
    if isinstance(word, Word):
        return {_choice_key(translation.normalized_text) for translation in word.translations}
    return {_choice_key(normalized) for _, normalized in word.translations}


def _answer_side(word: ChoiceCandidate, direction: str) -> tuple[str, str]:
    """Answer label and the key that keeps two options from looking the same.

    A user's word shows every translation together. A filler keeps one ordinary sense.
    """
    if direction == "en_ru":
        if isinstance(word, Word):
            label = ", ".join(translation.text for translation in word.translations)
        else:
            label = word.translations[0][0]
        # The key is the visible label. Separate senses can still render the same text.
        return label, _choice_key(normalize(label))
    return word.headword, _choice_key(word.normalized_headword)


def _seconds(value: datetime) -> float:
    return (value - datetime.min).total_seconds()


def _arrange(
    words: list[Word], schedules: dict[str, WordProgress], order: str, rng: random.Random
) -> list[Word]:
    """Order a session pool. Random stays a shuffle. The other orders are stable."""
    if order == "random":
        return rng.sample(words, len(words))

    def key(word: Word) -> tuple[object, ...]:
        reviewed = schedules[word.id].last_review_at
        if order == "reviewed_desc":
            return (reviewed is None, -_seconds(reviewed) if reviewed else 0, word.id)
        if order == "reviewed_asc":
            return (reviewed is None, _seconds(reviewed) if reviewed else 0, word.id)
        if order == "created_desc":
            return (-_seconds(word.created_at), word.id)
        if order == "created_asc":
            return (_seconds(word.created_at), word.id)
        if order == "progress_asc":
            return (word.progress, word.id)
        return (-word.progress, word.id)

    return sorted(words, key=key)


def _shuffle_selected(
    words: list[Word], size: int | Literal["all"], rng: random.Random, *, due_count: int = 0
) -> list[Word]:
    """Keep the ordered prefix, then shuffle presentation.

    Due words stay ahead of new ones. Size is applied before the shuffle, so a
    later unusable word does not pull in anything outside that prefix.
    """
    selected = words if size == "all" else words[:size]
    if len(selected) < 2:
        return selected
    head = min(due_count, len(selected))
    due = rng.sample(selected[:head], head) if head > 1 else selected[:head]
    tail = selected[head:]
    if len(tail) > 1:
        tail = rng.sample(tail, len(tail))
    return due + tail


def _prompt_text(word: Word, direction: str) -> str:
    if direction == "en_ru":
        return word.headword
    return ", ".join(translation.text for translation in word.translations)


def _prompt_transcription(word: Word | None, mode: str, direction: str) -> str | None:
    """IPA of the English prompt. Hidden when the English word is the answer."""
    if word is None or mode == "cloze" or direction == "ru_en":
        return None
    text = (word.transcription or "").strip()
    return text or None


def _build_item(
    target: Word, pool: list[ChoiceCandidate], direction: str
) -> tuple[str, list[str], int] | None:
    """Return (prompt, options, correct index), or None if no unambiguous distractors exist."""

    answer, answer_key = _answer_side(target, direction)
    seen = {answer_key}
    distractors: list[str] = []
    for other in _rng.sample(pool, len(pool)):
        # Skip anything that could also be a right answer for the target.
        if isinstance(other, Word) and other.id == target.id:
            continue
        if _choice_key(other.normalized_headword) == _choice_key(target.normalized_headword):
            continue
        if _meanings(other) & _meanings(target):
            continue
        text, key = _answer_side(other, direction)
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
    return _prompt_text(target, direction), options, correct


async def _select_targets(
    body: SessionIn, auth: CurrentAuth, db: Db, rng: random.Random
) -> tuple[list[Word], dict[str, WordProgress], list[ChoiceCandidate], str | None]:
    builtin_pool = distractors.choice_candidates() if body.mode == "choice" else []
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
            select(Word)
            .where(
                Word.owner_id == auth.user.id,
                Word.is_excluded.is_(False),
                Word.is_learned.is_(False),
            )
            .order_by(Word.id)
        )
    )
    matching_ids: set[str] | None = None
    if tag_ids:
        rows = await db.execute(
            select(WordTag.word_id)
            .where(WordTag.owner_id == auth.user.id, WordTag.tag_id.in_(tag_ids))
            .distinct()
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
        return [], {}, [*pool, *builtin_pool], "no_matching_words"

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
            schedules[word.id] = WordProgress(
                owner_id=auth.user.id,
                word_id=word.id,
                has_review=False,
                progress_version=1,
                last_review_at=None,
                due_at=None,
            )

    if body.purpose == "free":
        targets = _arrange(filtered, schedules, body.order, rng)
        if body.shuffle:
            targets = _shuffle_selected(targets, body.size, rng)
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
        # Due words stay ahead of new ones. The chosen order applies inside each group.
        due_targets = _arrange(due, schedules, body.order, rng)
        new_targets = _arrange(new, schedules, body.order, rng)[:10] if body.include_new else []
        targets = due_targets + new_targets
        if body.shuffle:
            targets = _shuffle_selected(targets, body.size, rng, due_count=len(due_targets))
        if not targets:
            return [], schedules, [*pool, *builtin_pool], "no_scheduled_words"

    if body.mode == "matching":
        matching_targets: list[Word] = []
        remaining = targets
        while remaining and (body.size == "all" or len(matching_targets) < body.size):
            current_batch: list[Word] = []
            deferred: list[Word] = []
            for index, target in enumerate(remaining):
                if body.purpose == "scheduled" and not schedules[target.id].has_review:
                    # A partial due batch cannot be split without changing the snapshot
                    # format; do not carry its conflicts past newly introduced words.
                    deferred = [word for word in deferred if not schedules[word.id].has_review]
                _label, answer_key = _answer_side(target, "en_ru")
                if any(
                    _choice_key(other.normalized_headword)
                    == _choice_key(target.normalized_headword)
                    or _meanings(other) & _meanings(target)
                    or _answer_side(other, "en_ru")[1] == answer_key
                    for other in current_batch
                ):
                    deferred.append(target)
                    continue
                matching_targets.append(target)
                current_batch.append(target)
                if len(current_batch) == 8 or (
                    body.size != "all" and len(matching_targets) == body.size
                ):
                    remaining = deferred + remaining[index + 1 :]
                    break
            else:
                break
        targets = matching_targets
    else:
        eligible: list[Word] = []
        for target in targets:
            if body.size != "all" and len(eligible) == body.size:
                break
            if (
                body.mode != "choice"
                or _build_item(target, [*pool, *builtin_pool], body.direction) is not None
            ):
                eligible.append(target)
        targets = eligible
    return targets, schedules, [*pool, *builtin_pool], None if targets else "not_enough_words"


@router.post("/sessions/preview")
async def preview_session(body: SessionIn, auth: CurrentAuth, db: Db) -> PreviewOut:
    seed = (
        body.selection_seed if body.selection_seed is not None else f"{_rng.getrandbits(128):032x}"
    )
    targets, _, _, reason = await _select_targets(body, auth, db, random.Random(int(seed, 16)))  # noqa: S311
    return PreviewOut(count=len(targets), selection_seed=seed, unavailable_reason=reason)


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
async def create_session(body: SessionIn, auth: CurrentAuth, db: Db) -> SessionOut:
    rng = random.Random(int(body.selection_seed, 16)) if body.selection_seed is not None else _rng  # noqa: S311
    targets, schedules, pool, reason = await _select_targets(body, auth, db, rng)
    if reason is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, reason)
    for schedule in schedules.values():
        if schedule not in db:
            db.add(schedule)
    session = TrainingSession(
        owner_id=auth.user.id,
        mode=body.mode,
        direction=body.direction,
        purpose=body.purpose,
        difficulty=auth.user.difficulty,
        requested_size=str(body.size),
    )
    if body.mode == "matching":
        matching_targets = targets
        for offset in range(0, len(matching_targets), 8):
            batch = matching_targets[offset : offset + 8]
            options = _rng.sample([_answer_side(word, "en_ru")[0] for word in batch], len(batch))
            for target in batch:
                session.items.append(
                    TrainingItem(
                        word_id=target.id,
                        word_content_version=target.content_version,
                        word_training_version=target.training_version,
                        word_progress_version=schedules[target.id].progress_version,
                        position=len(session.items),
                        prompt=target.headword,
                        options=options,
                        correct_option=options.index(_answer_side(target, "en_ru")[0]),
                    )
                )
    else:
        for target in targets:
            if body.size != "all" and len(session.items) == body.size:
                break
            if body.mode == "choice":
                built = _build_item(target, pool, body.direction)
                if built is None:
                    continue
                prompt, options, correct = built
                expected_answers = None
            else:
                prompt = _prompt_text(target, body.direction)
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
        raise HTTPException(status.HTTP_409_CONFLICT, "not_enough_words")

    shown_transcription = {
        word.id: _prompt_transcription(word, body.mode, body.direction) for word in targets
    }
    db.add(session)
    await db.commit()
    return SessionOut(
        id=session.id,
        mode=session.mode,
        direction=session.direction,
        purpose=body.purpose,
        items=[
            ItemOut(
                id=i.id,
                prompt=i.prompt,
                options=i.options,
                transcription=shown_transcription.get(i.word_id) if i.word_id else None,
                word_id=i.word_id,
            )
            for i in session.items
        ],
    )


async def _session_snapshot(session: TrainingSession, auth: CurrentAuth, db: Db) -> dict[str, Any]:
    items = session.items
    if session.mode == "matching":
        offset = 0
        while offset < len(items):
            options = items[offset].options
            size = len(options)
            batch = items[offset : offset + size]
            if (
                not 1 <= size <= 8
                or len(batch) != size
                or any(
                    item.position != offset + index
                    or item.options != options
                    or item.correct_option is None
                    or not 0 <= item.correct_option < size
                    for index, item in enumerate(batch)
                )
            ):
                raise HTTPException(409, "invalid_matching_snapshot")
            offset += size
    words = {
        word.id: word
        for word in await db.scalars(
            select(Word).where(
                Word.owner_id == auth.user.id,
                Word.id.in_([item.word_id for item in items if item.word_id]),
            )
        )
    }
    output = []
    for item in items:
        word = words.get(item.word_id) if item.word_id else None
        result: dict[str, Any] | None = None
        if word is None and item.outcome is not None and item.outcome != "unavailable":
            state = "done"
            result = _answer_out(item, None).model_dump()
        elif word is None:
            state = "done"
            result = UnavailableOut(reason="word_deleted", progress=None).model_dump()
        elif item.outcome is not None:
            state = "done"
            result = _answer_out(item, word.progress).model_dump()
        elif word.is_learned:
            state = "done"
            result = UnavailableOut(progress=word.progress).model_dump()
        elif item.answered_at is not None:
            state = "retryable"
            result = {
                "outcome": "retryable",
                "correct": False,
                "delta": item.delta,
                "progress": word.progress,
            }
            if item.chosen_option is not None:
                result["chosen_option"] = item.chosen_option
            if item.submitted_text is not None:
                result["submitted_text"] = item.submitted_text
        elif item.revealed_at is not None:
            state = "revealed"
            result = RevealOut(expected_answers=item.expected_answers or []).model_dump()
        else:
            state = "open"
        output.append(
            {
                "id": item.id,
                "word_id": item.word_id,
                "prompt": item.prompt,
                "options": item.options,
                "transcription": _prompt_transcription(word, session.mode, session.direction),
                "state": state,
                "result": result,
            }
        )
    return {
        "id": session.id,
        "mode": session.mode,
        "direction": session.direction,
        "purpose": session.purpose,
        "status": session.status,
        "created_at": session.created_at,
        "finished_at": session.finished_at,
        "requested_size": int(session.requested_size)
        if session.requested_size and session.requested_size != "all"
        else session.requested_size,
        "items": output,
    }


@router.get("/sessions/latest")
async def latest_session(auth: CurrentAuth, db: Db) -> dict[str, Any] | None:
    session = await db.scalar(
        select(TrainingSession)
        .where(TrainingSession.owner_id == auth.user.id)
        .order_by(TrainingSession.created_at.desc(), TrainingSession.id.desc())
        .limit(1)
    )
    if session is None:
        return None
    try:
        return await _session_snapshot(session, auth, db)
    except HTTPException as error:
        if error.detail != "invalid_matching_snapshot":
            raise
        return {
            "id": session.id,
            "mode": session.mode,
            "direction": session.direction,
            "purpose": session.purpose,
            "status": session.status,
            "created_at": session.created_at,
            "finished_at": session.finished_at,
            "requested_size": int(session.requested_size)
            if session.requested_size and session.requested_size != "all"
            else session.requested_size,
            "resume_error": "invalid_matching_snapshot",
            "items": [],
        }


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, auth: CurrentAuth, db: Db) -> dict[str, Any]:
    session = await db.scalar(
        select(TrainingSession).where(
            TrainingSession.id == session_id, TrainingSession.owner_id == auth.user.id
        )
    )
    if session is None:
        raise HTTPException(404, "session_not_found")
    return await _session_snapshot(session, auth, db)


@router.post("/sessions/{session_id}/finish")
async def finish_session(session_id: str, auth: CurrentAuth, db: Db) -> dict[str, Any]:
    await db.execute(
        update(TrainingSession)
        .where(
            TrainingSession.id == session_id,
            TrainingSession.owner_id == auth.user.id,
            TrainingSession.status == "active",
        )
        .values(status="finished", finished_at=utcnow())
    )
    await db.commit()
    session = await db.scalar(
        select(TrainingSession).where(
            TrainingSession.id == session_id, TrainingSession.owner_id == auth.user.id
        )
    )
    if session is None:
        raise HTTPException(404, "session_not_found")
    return {"id": session.id, "status": session.status, "finished_at": session.finished_at}


def _answer_out(item: TrainingItem, word_progress: int | None) -> TerminalOut:
    assert item.delta is not None
    if item.outcome == "unavailable":
        return UnavailableOut(progress=word_progress)
    if item.outcome == "skipped":
        return SkippedOut(progress=word_progress)
    if item.outcome == "assisted":
        if item.session.mode in ("choice", "matching"):
            assert item.correct_option is not None
            return ChoiceAssistedOut(
                expected_answers=[item.options[item.correct_option]],
                correct_option=item.correct_option,
                progress=word_progress,
            )
        assert item.expected_answers is not None
        return AssistedOut(expected_answers=item.expected_answers, progress=word_progress)
    assert item.outcome in (None, "answered") and item.answered_at is not None
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
) -> tuple[TrainingItem, Word | None]:
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
    return item, word


def _owned_sessions(auth: CurrentAuth) -> Select[str]:
    return select(TrainingSession.id).where(
        TrainingSession.owner_id == auth.user.id, TrainingSession.status == "active"
    )


def _eligible(auth: CurrentAuth) -> Exists:
    return (
        select(Word.id)
        .where(
            Word.id == TrainingItem.word_id,
            Word.owner_id == auth.user.id,
            Word.is_excluded.is_(False),
            Word.is_learned.is_(False),
            Word.training_version == TrainingItem.word_training_version,
        )
        .exists()
    )


@router.post("/items/{item_id}/reveal")
async def reveal_item(item_id: str, auth: CurrentAuth, db: Db) -> RevealOut | TerminalOut:
    item, word = await _owned_item_and_word(item_id, auth, db)

    if word is None:
        if item.outcome is not None and item.outcome != "unavailable":
            return _answer_out(item, None)
        if item.session.status != "active" and item.outcome is None:
            raise HTTPException(409, "session_finished")
        return UnavailableOut(reason="word_deleted", progress=None)

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

    session_status = await db.scalar(
        select(TrainingSession.status).where(TrainingSession.id == item.session_id)
    )
    await db.refresh(item, ["session"])
    if session_status != "active" and item.outcome is None:
        raise HTTPException(409, "session_finished")

    if item.outcome is not None:
        return _answer_out(item, word.progress)
    assert item.expected_answers is not None
    return RevealOut(expected_answers=item.expected_answers)


@router.post("/items/{item_id}/skip")
async def skip_item(item_id: str, auth: CurrentAuth, db: Db) -> TerminalOut:
    item, word = await _owned_item_and_word(item_id, auth, db)
    if word is None:
        if item.outcome is not None and item.outcome != "unavailable":
            return _answer_out(item, None)
        if item.session.status != "active" and item.outcome is None:
            raise HTTPException(409, "session_finished")
        return UnavailableOut(reason="word_deleted", progress=None)
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
        session_status = await db.scalar(
            select(TrainingSession.status).where(TrainingSession.id == item.session_id)
        )
        await db.refresh(item, ["session"])
    else:
        session_status = item.session.status
    if session_status != "active" and item.outcome is None:
        raise HTTPException(409, "session_finished")
    return _answer_out(item, word.progress)


@router.post("/items/{item_id}/hint")
async def hint_item(item_id: str, body: LetterHintIn, auth: CurrentAuth, db: Db) -> LetterHintOut:
    item, word = await _owned_item_and_word(item_id, auth, db)
    if item.session.mode not in ("input", "cloze") or not item.expected_answers:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_answer_for_mode")
    if word is None or item.outcome is not None or item.session.status != "active":
        raise HTTPException(409, "item_closed")
    shown, complete = hinted_text(body.text, item.expected_answers)
    if normalize(body.text) and normalize(body.text) in {
        normalize(answer) for answer in item.expected_answers
    }:
        return LetterHintOut(text=body.text, complete=True)
    claimed = await db.execute(
        update(TrainingItem)
        .where(
            TrainingItem.id == item.id,
            TrainingItem.session_id.in_(_owned_sessions(auth)),
            TrainingItem.outcome.is_(None),
            _eligible(auth),
        )
        .values(letter_hints=TrainingItem.letter_hints + 1)
    )
    if claimed.rowcount != 1:  # type: ignore[attr-defined]
        await db.rollback()
        raise HTTPException(409, "item_closed")
    await db.commit()
    return LetterHintOut(text=shown, complete=complete)


@router.post("/items/{item_id}/answer")
async def answer_item(
    item_id: str, body: AnswerIn | TextAnswerIn | GradeAnswerIn, auth: CurrentAuth, db: Db
) -> TerminalOut:
    item, word = await _owned_item_and_word(item_id, auth, db)

    if word is None:
        if item.outcome is not None and item.outcome != "unavailable":
            return _answer_out(item, None)
        if item.session.status != "active" and item.outcome is None:
            raise HTTPException(409, "session_finished")
        return UnavailableOut(reason="word_deleted", progress=None)

    if (
        (item.session.mode in ("choice", "matching") and not isinstance(body, AnswerIn))
        or (item.session.mode in ("input", "cloze") and not isinstance(body, TextAnswerIn))
        or (item.session.mode == "cards" and not isinstance(body, GradeAnswerIn))
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_answer_for_mode")
    if isinstance(body, AnswerIn) and body.option >= len(item.options):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_option")
    if item.outcome is not None:
        return _answer_out(item, word.progress)

    first_attempt = item.answered_at is None
    if isinstance(body, AnswerIn):
        correct = body.option == item.correct_option
        kind = AnswerKind.CHOICE
        chosen_option = body.option
        submitted_text = None
        grade = "good" if correct else "again"
    elif isinstance(body, TextAnswerIn):
        assert item.expected_answers is not None
        correct = normalize(body.text) in {normalize(answer) for answer in item.expected_answers}
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
    change = progress.with_letter_hint(
        0
        if not first_attempt or grade == "hard"
        else progress.delta(
            item.session.difficulty,
            kind,
            correct if correct is not None else grade != "again",
            matching=item.session.mode == "matching",
        ),
        item.letter_hints > 0,
    )
    now = utcnow()
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
    attempt_guard = (
        (TrainingItem.answered_at.is_(None),)
        if first_attempt
        else (TrainingItem.answered_at.is_not(None), TrainingItem.is_correct.is_(False))
    )
    claimed = await db.execute(
        update(TrainingItem)
        .where(
            TrainingItem.id == item.id,
            TrainingItem.session_id.in_(_owned_sessions(auth)),
            TrainingItem.outcome.is_(None),
            card_ready,
            *attempt_guard,
        )
        .values(
            chosen_option=case((eligible, chosen_option), else_=None),
            submitted_text=case((eligible, submitted_text), else_=None),
            grade=case((eligible, grade), else_=None),
            is_correct=case((eligible, correct), else_=None),
            delta=case(
                (eligible & (current_version == item.word_content_version), change), else_=0
            ),
            outcome=case((eligible, None if correct is False else "answered"), else_="unavailable"),
            answered_at=func.coalesce(TrainingItem.answered_at, now),
        )
    )
    if claimed.rowcount == 1 and first_attempt:  # type: ignore[attr-defined]
        state = (
            await db.execute(
                select(
                    Word.content_version,
                    Word.training_version,
                    Word.is_excluded,
                    Word.is_learned,
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
            and not state[3]
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
                transition = srs.review(state[4], state[5], cast(Grade, grade), now)
                changed = await db.execute(
                    schedule_update.values(
                        stage=transition.stage,
                        has_review=True,
                        due_at=transition.due_at,
                        last_review_at=now,
                        success_streak=transition.success_streak,
                        review_count=state[6] + 1,
                        lapse_count=state[7] + int(transition.is_lapse),
                        progress_version=item.word_progress_version + 1,
                    )
                )
            else:
                changed = await db.execute(
                    schedule_update.values(progress_version=item.word_progress_version + 1)
                )
            if changed.rowcount != 1:  # type: ignore[attr-defined]
                await db.rollback()
                raise HTTPException(status.HTTP_409_CONFLICT, "PROGRESS_CHANGED")
            applied = await db.execute(
                update(Word)
                .where(
                    Word.id == word.id,
                    Word.owner_id == auth.user.id,
                    Word.is_excluded.is_(False),
                    Word.is_learned.is_(False),
                    Word.training_version == item.word_training_version,
                    Word.content_version == item.word_content_version,
                )
                .values(progress=func.max(progress.MIN_PROGRESS, Word.progress + change))
            )
            if applied.rowcount != 1:  # type: ignore[attr-defined]
                await db.rollback()
                raise HTTPException(status.HTTP_409_CONFLICT, "PROGRESS_CHANGED")
            if correct is not None:
                db.add(
                    AnswerEvent(
                        owner_id=auth.user.id,
                        item_id=item.id,
                        session_id=item.session_id,
                        word_id=word.id,
                        created_at=now,
                        mode=item.session.mode,
                        direction=item.session.direction,
                        purpose=item.session.purpose,
                        correct=correct,
                        delta=change,
                    )
                )
    await db.commit()
    await db.refresh(item)
    await db.refresh(word)

    session_status = await db.scalar(
        select(TrainingSession.status).where(TrainingSession.id == item.session_id)
    )
    await db.refresh(item, ["session"])
    if session_status != "active" and claimed.rowcount != 1 and item.outcome is None:  # type: ignore[attr-defined]
        raise HTTPException(409, "session_finished")

    if item.outcome is None and item.answered_at is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "card_not_revealed")
    return _answer_out(item, word.progress)
