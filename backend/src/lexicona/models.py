from datetime import datetime
from uuid import uuid4

from sqlalchemy import JSON, CheckConstraint, ForeignKey, String, Text, UniqueConstraint
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
    __table_args__ = (CheckConstraint("progress BETWEEN 0 AND 100", name="progress_range"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    headword: Mapped[str] = mapped_column(String(200))
    normalized_headword: Mapped[str] = mapped_column(String(200), index=True)
    transcription: Mapped[str | None] = mapped_column(String(300))
    example_en: Mapped[str | None] = mapped_column(Text)
    example_ru: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    progress: Mapped[int] = mapped_column(default=0)
    # Bumped on every meaningful edit so stale training answers stop counting.
    content_version: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)

    translations: Mapped[list[WordTranslation]] = relationship(
        order_by="WordTranslation.position",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class WordTranslation(Base):
    __tablename__ = "word_translations"
    __table_args__ = (UniqueConstraint("word_id", "position"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    word_id: Mapped[str] = mapped_column(ForeignKey("words.id", ondelete="CASCADE"), index=True)
    # Position 0 is the primary translation.
    position: Mapped[int]
    text: Mapped[str] = mapped_column(String(200))
    normalized_text: Mapped[str] = mapped_column(String(200))


class TrainingSession(Base):
    __tablename__ = "training_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    mode: Mapped[str] = mapped_column(String(16))
    direction: Mapped[str] = mapped_column(String(8))
    # Frozen at session start: changing the setting affects only new sessions.
    difficulty: Mapped[Difficulty] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

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
    word_id: Mapped[str] = mapped_column(ForeignKey("words.id", ondelete="CASCADE"), index=True)
    word_content_version: Mapped[int]
    position: Mapped[int]
    prompt: Mapped[str] = mapped_column(String(200))
    options: Mapped[list[str]] = mapped_column(JSON)
    correct_option: Mapped[int | None]
    chosen_option: Mapped[int | None]
    expected_answers: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    submitted_text: Mapped[str | None] = mapped_column(String(200), nullable=True)
    revealed_at: Mapped[datetime | None]
    grade: Mapped[str | None] = mapped_column(String(8), nullable=True)
    is_correct: Mapped[bool | None]
    delta: Mapped[int | None]
    answered_at: Mapped[datetime | None]

    session: Mapped[TrainingSession] = relationship(back_populates="items", lazy="joined")
