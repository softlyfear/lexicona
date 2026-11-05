from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    Text,
    UniqueConstraint,
    false,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from lexicona.db import utcnow
from lexicona.progress import Difficulty


def new_id() -> str:
    return uuid4().hex


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    login: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(default=False)
    difficulty: Mapped[Difficulty] = mapped_column(String(16), default=Difficulty.MEDIUM)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    statistics_started_at: Mapped[datetime] = mapped_column(
        default=utcnow, server_default=text("CURRENT_TIMESTAMP")
    )


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    expires_at: Mapped[datetime]

    user: Mapped[User] = relationship(lazy="joined")


class Word(Base):
    __tablename__ = "words"
    __table_args__ = (
        CheckConstraint("progress >= 0", name="progress_range"),
        Index("ix_words_owner_id_id", "owner_id", "id", unique=True),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    headword: Mapped[str] = mapped_column(String(200))
    normalized_headword: Mapped[str] = mapped_column(String(200), index=True)
    source_refs: Mapped[list[dict[str, object]] | None] = mapped_column(JSON, nullable=True)
    transcription: Mapped[str | None] = mapped_column(String(300))
    example_en: Mapped[str | None] = mapped_column(Text)
    example_ru: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    progress: Mapped[int] = mapped_column(default=0)
    is_excluded: Mapped[bool] = mapped_column(default=False, server_default=false())
    # Explicit mark. Independent of progress and of exclusion from training.
    is_learned: Mapped[bool] = mapped_column(default=False, server_default=false())
    training_version: Mapped[int] = mapped_column(default=1, server_default=text("1"))
    # Bumped on every meaningful edit so stale training answers stop counting.
    content_version: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)

    translations: Mapped[list[WordTranslation]] = relationship(
        order_by="WordTranslation.position",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class Tag(Base):
    __tablename__ = "tags"
    __table_args__ = (
        UniqueConstraint("owner_id", "normalized_name"),
        UniqueConstraint("owner_id", "id"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(80))
    normalized_name: Mapped[str] = mapped_column(Text)


class WordTag(Base):
    __tablename__ = "word_tags"
    __table_args__ = (
        ForeignKeyConstraint(
            ["owner_id", "word_id"], ["words.owner_id", "words.id"], ondelete="CASCADE"
        ),
        ForeignKeyConstraint(
            ["owner_id", "tag_id"], ["tags.owner_id", "tags.id"], ondelete="CASCADE"
        ),
        UniqueConstraint("word_id", "tag_id"),
    )

    owner_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    word_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    tag_id: Mapped[str] = mapped_column(String(32), primary_key=True)


class WordTranslation(Base):
    __tablename__ = "word_translations"
    __table_args__ = (UniqueConstraint("word_id", "position"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    word_id: Mapped[str] = mapped_column(ForeignKey("words.id", ondelete="CASCADE"), index=True)
    # Position 0 is the primary translation.
    position: Mapped[int]
    text: Mapped[str] = mapped_column(String(200))
    normalized_text: Mapped[str] = mapped_column(String(200))


class WordProgress(Base):
    __tablename__ = "word_progress"
    __table_args__ = (
        ForeignKeyConstraint(
            ["owner_id", "word_id"], ["words.owner_id", "words.id"], ondelete="CASCADE"
        ),
        CheckConstraint("stage BETWEEN 0 AND 6", name="word_progress_stage_range"),
        CheckConstraint(
            "success_streak >= 0 AND review_count >= 0 AND lapse_count >= 0 "
            "AND progress_version >= 1",
            name="word_progress_counters",
        ),
        Index("ix_word_progress_owner_due", "owner_id", "due_at"),
    )

    owner_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    word_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    stage: Mapped[int] = mapped_column(default=0, server_default=text("0"))
    has_review: Mapped[bool] = mapped_column(default=False, server_default=false())
    due_at: Mapped[datetime | None]
    last_review_at: Mapped[datetime | None]
    success_streak: Mapped[int] = mapped_column(default=0, server_default=text("0"))
    review_count: Mapped[int] = mapped_column(default=0, server_default=text("0"))
    lapse_count: Mapped[int] = mapped_column(default=0, server_default=text("0"))
    progress_version: Mapped[int] = mapped_column(default=1, server_default=text("1"))


class TrainingSession(Base):
    __tablename__ = "training_sessions"
    __table_args__ = (
        CheckConstraint("purpose IN ('scheduled', 'free')", name="training_session_purpose"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    mode: Mapped[str] = mapped_column(String(16))
    direction: Mapped[str] = mapped_column(String(8))
    purpose: Mapped[str] = mapped_column(String(16), default="free", server_default="free")
    # Frozen at session start: changing the setting affects only new sessions.
    difficulty: Mapped[Difficulty] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    status: Mapped[str] = mapped_column(String(16), default="active", server_default="active")
    finished_at: Mapped[datetime | None]
    requested_size: Mapped[str | None] = mapped_column(String(32))

    items: Mapped[list[TrainingItem]] = relationship(
        back_populates="session",
        order_by="TrainingItem.position",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class TrainingItem(Base):
    __tablename__ = "training_items"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("training_sessions.id", ondelete="CASCADE"), index=True
    )
    word_id: Mapped[str | None] = mapped_column(
        ForeignKey("words.id", ondelete="SET NULL"), index=True
    )
    word_content_version: Mapped[int]
    word_training_version: Mapped[int] = mapped_column(default=1, server_default=text("1"))
    word_progress_version: Mapped[int] = mapped_column(default=1, server_default=text("1"))
    position: Mapped[int]
    prompt: Mapped[str] = mapped_column(Text)
    options: Mapped[list[str]] = mapped_column(JSON)
    correct_option: Mapped[int | None]
    chosen_option: Mapped[int | None]
    expected_answers: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    submitted_text: Mapped[str | None] = mapped_column(String(200), nullable=True)
    revealed_at: Mapped[datetime | None]
    grade: Mapped[str | None] = mapped_column(String(8), nullable=True)
    outcome: Mapped[str | None] = mapped_column(String(16), nullable=True)
    is_correct: Mapped[bool | None]
    delta: Mapped[int | None]
    answered_at: Mapped[datetime | None]

    session: Mapped[TrainingSession] = relationship(back_populates="items", lazy="joined")


class AnswerEvent(Base):
    __tablename__ = "answer_events"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    item_id: Mapped[str] = mapped_column(String(32), unique=True)
    session_id: Mapped[str] = mapped_column(String(32))
    word_id: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    mode: Mapped[str] = mapped_column(String(16))
    direction: Mapped[str] = mapped_column(String(8))
    purpose: Mapped[str] = mapped_column(String(16))
    correct: Mapped[bool]
    delta: Mapped[int]
