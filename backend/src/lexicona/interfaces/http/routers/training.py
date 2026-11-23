import random
from datetime import UTC, datetime
from hashlib import sha256
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
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.sql.selectable import Exists

from lexicona.domain import distractors, progress, srs
from lexicona.domain.normalize import hinted_steps, hinted_text, normalize, normalize_answer
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
from lexicona.interfaces.http.preferences import public_preferences

router = APIRouter(prefix="/training", tags=["training"])

OPTION_COUNT = 6
DEFAULT_TRAINING_SIZE = 10
_rng = random.SystemRandom()
OfflineMode = Literal["input", "choice"]
OfflineDirection = Literal["en_ru", "ru_en"]
OfflineTrackVersion = Literal[2, 3]
_OFFLINE_CHOICE_TRACKS: tuple[tuple[OfflineMode, OfflineDirection], ...] = (
    ("choice", "en_ru"),
    ("choice", "ru_en"),
)


class SessionIn(BaseModel):
    mode: Literal["choice", "input", "matching"] = "choice"
    direction: Literal["en_ru", "ru_en", "en_en"] = "en_ru"
    purpose: Literal["scheduled", "free"] = "free"
    include_new: StrictBool = True
    size: Annotated[int, Field(ge=1, strict=True)] | Literal["all"] = DEFAULT_TRAINING_SIZE
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
    include_learned: StrictBool = False
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


class OfflinePackIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{32}$", strict=True)]
    version: Literal[1, 2, 3] = 1


class OfflineStudyWord(BaseModel):
    headword: str
    translations: list[str]


class OfflineExercise(BaseModel):
    id: str
    prompt: str


class OfflinePackInfo(BaseModel):
    owner_id: str
    expires_at: datetime
    id: str
    requested_size: int | Literal["all"]
    study: list[OfflineStudyWord]


class OfflinePackOut(OfflinePackInfo):
    items: list[OfflineExercise]


class OfflineTrackItem(OfflineExercise):
    options: list[str]


class OfflineTrack(BaseModel):
    id: str
    mode: OfflineMode
    direction: OfflineDirection
    items: list[OfflineTrackItem]


class OfflineTracksPackOut(OfflinePackInfo):
    exercises: list[OfflineTrack]


class OfflinePackV2Out(OfflineTracksPackOut):
    version: Literal[2] = 2


class OfflinePackV3Out(OfflineTracksPackOut):
    version: Literal[3] = 3


class CompletionCounts(BaseModel):
    answered: int = 0
    assisted: int = 0
    skipped: int = 0
    unavailable: int = 0
    pending: int = 0


class FirstAttemptCounts(BaseModel):
    correct: int = 0
    incorrect: int = 0
    assisted: int = 0
    unknown: int = 0
    not_attempted: int = 0
    not_applicable: int = 0
    accuracy_percent: float | None = None


class SessionSummaryOut(BaseModel):
    id: str
    total: int
    completion: CompletionCounts
    first_attempt: FirstAttemptCounts


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


def _input_item(word: Word, direction: str, position: int, schedule: WordProgress) -> TrainingItem:
    return TrainingItem(
        word_id=word.id,
        word_content_version=word.content_version,
        word_training_version=word.training_version,
        word_progress_version=schedule.progress_version,
        position=position,
        prompt=_prompt_text(word, direction),
        options=[],
        expected_answers=(
            [translation.text for translation in word.translations]
            if direction == "en_ru"
            else [word.headword]
        ),
    )


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

    pool_filters = [
        Word.owner_id == auth.user.id,
        Word.is_excluded.is_(False),
    ]
    if not body.include_learned:
        pool_filters.append(Word.is_learned.is_(False))
    pool = list(await db.scalars(select(Word).where(*pool_filters).order_by(Word.id)))
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
        include_learned=body.include_learned,
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
            else:
                session.items.append(
                    _input_item(target, body.direction, len(session.items), schedules[target.id])
                )
                continue
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


@router.post("/offline-pack")
async def prepare_offline_pack(
    body: OfflinePackIn, auth: CurrentAuth, db: Db
) -> OfflinePackOut | OfflinePackV2Out | OfflinePackV3Out | None:
    owner_id = auth.user.id
    preferences = public_preferences(auth.user.preferences).training
    configured_size = preferences.size if preferences else DEFAULT_TRAINING_SIZE
    if body.version != 1:
        return await _prepare_offline_tracks(body.key, body.version, configured_size, auth, db)

    session_id = sha256(f"offline-training/{owner_id}/{body.key}".encode()).hexdigest()[:32]
    created_id = await db.scalar(
        sqlite_insert(TrainingSession)
        .values(
            id=session_id,
            owner_id=owner_id,
            mode="input",
            direction="en_ru",
            purpose="free",
            difficulty=auth.user.difficulty,
            requested_size=str(configured_size),
            is_offline=True,
        )
        .on_conflict_do_nothing(index_elements=[TrainingSession.id])
        .returning(TrainingSession.id)
    )
    # Inserting the parent first serializes requests for the same package key.
    session = await db.scalar(
        select(TrainingSession).where(
            TrainingSession.id == session_id,
            TrainingSession.owner_id == owner_id,
            TrainingSession.is_offline.is_(True),
        )
    )
    if session is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "offline_pack_key_conflict")

    size: int | Literal["all"] = (
        "all"
        if session.requested_size == "all"
        else int(session.requested_size or DEFAULT_TRAINING_SIZE)
    )
    eligible_words = _offline_words(owner_id).limit(None if size == "all" else size)

    if created_id:
        exercises = await db.execute(
            eligible_words.add_columns(WordProgress).outerjoin(
                WordProgress,
                (WordProgress.owner_id == Word.owner_id) & (WordProgress.word_id == Word.id),
            )
        )
        for position, (word, schedule) in enumerate(exercises):
            if schedule is None:
                schedule = WordProgress(owner_id=owner_id, word_id=word.id, progress_version=1)
                db.add(schedule)
            session.items.append(_input_item(word, session.direction, position, schedule))
        if not session.items:
            await db.rollback()
            return None

    study_words: list[Word] = []
    if size != "all":
        exercise_exists = (
            select(TrainingItem.id)
            .where(TrainingItem.session_id == session.id, TrainingItem.word_id == Word.id)
            .exists()
        )
        # The query autoflushes new items before looking up study translations.
        study_words = list(await db.scalars(eligible_words.where(~exercise_exists)))

    await db.commit()
    return OfflinePackOut(
        owner_id=owner_id,
        expires_at=auth.session.expires_at.replace(tzinfo=UTC),
        id=session.id,
        requested_size=size,
        study=_offline_study(study_words),
        items=[OfflineExercise(id=item.id, prompt=item.prompt) for item in session.items],
    )


def _offline_words(owner_id: str) -> Select[Word]:
    return (
        select(Word)
        .where(Word.owner_id == owner_id, Word.is_excluded.is_(False), Word.is_learned.is_(False))
        .order_by(Word.progress, Word.created_at, Word.id)
    )


def _offline_study(words: list[Word]) -> list[OfflineStudyWord]:
    return [
        OfflineStudyWord(headword=word.headword, translations=[t.text for t in word.translations])
        for word in words
    ]


async def _prepare_offline_tracks(
    key: str,
    version: OfflineTrackVersion,
    configured_size: int | Literal["all"],
    auth: CurrentAuth,
    db: Db,
) -> OfflinePackV2Out | OfflinePackV3Out | None:
    owner_id = auth.user.id
    written_direction: OfflineDirection = "en_ru" if version == 2 else "ru_en"
    track_types = (("input", written_direction), *_OFFLINE_CHOICE_TRACKS)
    track_ids = [
        sha256(
            f"offline-training-v{version}/{owner_id}/{key}/{mode}/{direction}".encode()
        ).hexdigest()[:32]
        for mode, direction in track_types
    ]
    pack_id = track_ids[0]
    defaults = {
        "owner_id": owner_id,
        "purpose": "free",
        "difficulty": auth.user.difficulty,
        "requested_size": str(configured_size),
        "is_offline": True,
    }
    # Claim the written track before allocating any words. All tracks are in this transaction.
    created_id = await db.scalar(
        sqlite_insert(TrainingSession)
        .values(id=pack_id, mode="input", direction=written_direction, **defaults)
        .on_conflict_do_nothing(index_elements=[TrainingSession.id])
        .returning(TrainingSession.id)
    )
    sessions = {
        session.id: session
        for session in await db.scalars(
            select(TrainingSession).where(
                TrainingSession.id.in_(track_ids),
                TrainingSession.owner_id == owner_id,
                TrainingSession.is_offline.is_(True),
            )
        )
    }
    written = sessions.get(pack_id)
    if written is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "offline_pack_key_conflict")
    size: int | Literal["all"] = (
        "all"
        if written.requested_size == "all"
        else int(written.requested_size or DEFAULT_TRAINING_SIZE)
    )
    if created_id:
        tracks = [written]
        for track_id, (mode, direction) in zip(track_ids[1:], track_types[1:], strict=True):
            tracks.append(TrainingSession(id=track_id, mode=mode, direction=direction, **defaults))
        study_words = await _populate_offline_tracks(tracks, size, owner_id, db)
        if not written.items:
            await db.rollback()
            return None
        sessions.update((track.id, track) for track in tracks if track.items)

    else:
        exercise_exists = (
            select(TrainingItem.id)
            .join(TrainingSession)
            .where(
                TrainingItem.session_id.in_(track_ids),
                TrainingSession.owner_id == owner_id,
                TrainingItem.word_id == Word.id,
            )
            .exists()
        )
        study_words = list(await db.scalars(_offline_words(owner_id).where(~exercise_exists)))
    await db.commit()
    response_type = OfflinePackV2Out if version == 2 else OfflinePackV3Out
    return response_type(
        owner_id=owner_id,
        expires_at=auth.session.expires_at.replace(tzinfo=UTC),
        id=pack_id,
        requested_size=size,
        study=_offline_study(study_words),
        exercises=[
            OfflineTrack(
                id=track_id,
                mode=mode,
                direction=direction,
                items=[
                    OfflineTrackItem(id=item.id, prompt=item.prompt, options=item.options)
                    for item in sessions[track_id].items
                ],
            )
            for track_id, (mode, direction) in zip(track_ids, track_types, strict=True)
            if track_id in sessions
        ],
    )


async def _populate_offline_tracks(
    tracks: list[TrainingSession], size: int | Literal["all"], owner_id: str, db: Db
) -> list[Word]:
    pool: list[ChoiceCandidate] = list(distractors.choice_candidates())
    candidates = await db.execute(
        _offline_words(owner_id)
        .add_columns(WordProgress)
        .outerjoin(
            WordProgress,
            (WordProgress.owner_id == Word.owner_id) & (WordProgress.word_id == Word.id),
        )
    )
    study_words: list[Word] = []
    track_index = 0
    for word, schedule in candidates:
        for offset in range(len(tracks)):
            index = (track_index + offset) % len(tracks)
            track = tracks[index]
            if size != "all" and len(track.items) >= size:
                continue
            choice = _build_item(word, pool, track.direction) if track.mode == "choice" else None
            if track.mode == "choice" and choice is None:
                continue
            if schedule is None:
                schedule = WordProgress(owner_id=owner_id, word_id=word.id, progress_version=1)
                db.add(schedule)
            if choice is None:
                item = _input_item(word, track.direction, len(track.items), schedule)
            else:
                prompt, options, correct = choice
                item = TrainingItem(
                    word_id=word.id,
                    word_content_version=word.content_version,
                    word_training_version=word.training_version,
                    word_progress_version=schedule.progress_version,
                    position=len(track.items),
                    prompt=prompt,
                    options=options,
                    correct_option=correct,
                )
            track.items.append(item)
            track_index = (index + 1) % len(tracks)
            break
        else:
            study_words.append(word)
    db.add_all(track for track in tracks[1:] if track.items)
    return study_words


async def _session_snapshot(
    session: TrainingSession, auth: CurrentAuth, db: Db, *, validate_matching: bool = True
) -> dict[str, Any]:
    items = session.items
    if session.mode == "matching" and validate_matching:
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
        elif (
            (word.is_learned and not session.include_learned)
            or word.training_version != item.word_training_version
            or (session.is_offline and word.content_version != item.word_content_version)
        ):
            state = "done"
            result = UnavailableOut(progress=word.progress).model_dump()
        elif item.answered_at is not None:
            state = "retryable"
            result = {
                "outcome": "retryable",
                "correct": False,
                "delta": item.delta if item.delta is not None else 0,
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
        .where(TrainingSession.owner_id == auth.user.id, TrainingSession.is_offline.is_(False))
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


@router.get("/sessions/{session_id}/summary")
async def session_summary(session_id: str, auth: CurrentAuth, db: Db) -> SessionSummaryOut:
    session = await db.scalar(
        select(TrainingSession).where(
            TrainingSession.id == session_id, TrainingSession.owner_id == auth.user.id
        )
    )
    if session is None:
        raise HTTPException(404, "session_not_found")
    snapshot = await _session_snapshot(session, auth, db, validate_matching=False)
    events = {
        event.item_id: event.correct
        for event in await db.scalars(
            select(AnswerEvent).where(
                AnswerEvent.owner_id == auth.user.id, AnswerEvent.session_id == session.id
            )
        )
    }
    completion = CompletionCounts()
    first = FirstAttemptCounts()
    for item, shown in zip(session.items, snapshot["items"], strict=True):
        category = shown["result"]["outcome"] if shown["state"] == "done" else "pending"
        setattr(completion, category, getattr(completion, category) + 1)
        if session.mode == "cards":
            first.not_applicable += 1
        elif item.id in events:
            # Events record first submissions, including those made with letter hints.
            if events[item.id]:
                first.correct += 1
            else:
                first.incorrect += 1
        elif (
            item.is_correct is not None
            or item.outcome == "answered"
            or (
                session.created_at < auth.user.statistics_started_at
                and item.answered_at is not None
            )
        ):
            # Mutable terminal answers cannot reconstruct a missing first attempt.
            first.unknown += 1
        elif category == "assisted":
            first.assisted += 1
        else:
            first.not_attempted += 1
    known = first.correct + first.incorrect
    if known and not first.unknown:
        first.accuracy_percent = round(first.correct * 100 / known, 1)
    return SessionSummaryOut(
        id=session.id, total=len(session.items), completion=completion, first_attempt=first
    )


def _answer_out(item: TrainingItem, word_progress: int | None) -> TerminalOut:
    delta = item.delta if item.delta is not None else 0
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
            delta=delta,
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
            delta=delta,
            progress=word_progress,
        )
    assert item.correct_option is not None
    assert item.chosen_option is not None
    return AnswerOut(
        correct=item.is_correct,
        correct_option=item.correct_option,
        chosen_option=item.chosen_option,
        delta=delta,
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


def _eligible(
    auth: CurrentAuth, *, include_learned: bool = False, current_content: bool = False
) -> Exists:
    filters = [
        Word.id == TrainingItem.word_id,
        Word.owner_id == auth.user.id,
        Word.is_excluded.is_(False),
        Word.training_version == TrainingItem.word_training_version,
    ]
    if not include_learned:
        filters.append(Word.is_learned.is_(False))
    if current_content:
        filters.append(Word.content_version == TrainingItem.word_content_version)
    return select(Word.id).where(*filters).exists()


@router.post("/items/{item_id}/reveal")
async def reveal_item(item_id: str, auth: CurrentAuth, db: Db) -> RevealOut | TerminalOut:
    item, word = await _owned_item_and_word(item_id, auth, db)
    if item.session.is_offline:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_answer_for_mode")

    if word is None:
        if item.outcome is not None and item.outcome != "unavailable":
            return _answer_out(item, None)
        if item.session.status != "active" and item.outcome is None:
            raise HTTPException(409, "session_finished")
        return UnavailableOut(reason="word_deleted", progress=None)

    if item.outcome is not None:
        return _answer_out(item, word.progress)

    eligible = _eligible(auth, include_learned=item.session.include_learned)
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
                outcome=case(
                    (
                        _eligible(
                            auth,
                            include_learned=item.session.include_learned,
                            current_content=item.session.is_offline,
                        ),
                        "skipped",
                    ),
                    else_="unavailable",
                ),
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
    if (
        item.session.is_offline
        or item.session.mode not in ("input", "cloze")
        or not item.expected_answers
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_answer_for_mode")
    if word is None or item.outcome is not None or item.session.status != "active":
        raise HTTPException(409, "item_closed")
    shown, complete = hinted_text(body.text, item.expected_answers)
    if normalize_answer(body.text) and normalize_answer(body.text) in {
        normalize_answer(answer) for answer in item.expected_answers
    }:
        return LetterHintOut(text=body.text, complete=True)
    claimed = await db.execute(
        update(TrainingItem)
        .where(
            TrainingItem.id == item.id,
            TrainingItem.session_id.in_(_owned_sessions(auth)),
            TrainingItem.outcome.is_(None),
            _eligible(auth, include_learned=item.session.include_learned),
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
        correct = normalize_answer(body.text) in {
            normalize_answer(answer) for answer in item.expected_answers
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
    fully_revealed = (
        correct is True
        and isinstance(body, TextAnswerIn)
        and any(
            normalize_answer(answer) == normalize_answer(body.text)
            and item.letter_hints >= hinted_steps(answer)
            for answer in item.expected_answers or []
        )
    )
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
        fully_revealed,
    )
    now = utcnow()
    current_version = (
        select(Word.content_version)
        .where(Word.id == item.word_id, Word.owner_id == auth.user.id)
        .scalar_subquery()
    )
    eligible = _eligible(
        auth,
        include_learned=item.session.include_learned,
        current_content=item.session.is_offline,
    )
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
            outcome=case(
                (
                    eligible,
                    None if correct is False and not item.session.is_offline else "answered",
                ),
                else_="unavailable",
            ),
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
            and (item.session.include_learned or not state[3])
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
            if item.session.purpose == "scheduled" and not fully_revealed:
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
            progress_filters = [
                Word.id == word.id,
                Word.owner_id == auth.user.id,
                Word.is_excluded.is_(False),
                Word.training_version == item.word_training_version,
                Word.content_version == item.word_content_version,
            ]
            if not item.session.include_learned:
                progress_filters.append(Word.is_learned.is_(False))
            applied = await db.execute(
                update(Word)
                .where(*progress_filters)
                .values(
                    progress=func.min(
                        progress.MAX_PROGRESS,
                        func.max(progress.MIN_PROGRESS, Word.progress + change),
                    )
                )
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
