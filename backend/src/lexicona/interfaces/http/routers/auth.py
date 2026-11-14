from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Self

from anyio import to_thread
from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator
from sqlalchemy import delete, insert, literal, select, update
from sqlalchemy.exc import OperationalError

from lexicona.domain.progress import Difficulty
from lexicona.infrastructure.db import utcnow
from lexicona.infrastructure.models import AuthSession, User, new_id
from lexicona.infrastructure.security import (
    LoginThrottle,
    hash_password,
    new_token,
    token_hash,
    verify_password,
)
from lexicona.interfaces.http.deps import SESSION_COOKIE, AppSettings, CurrentAuth, Db
from lexicona.interfaces.http.preferences import (
    AccountPreferences,
    SpeechPreferences,
    TrainingPreferences,
    preference_document,
    public_preferences,
)

router = APIRouter(prefix="/auth", tags=["auth"])
throttle = LoginThrottle()
password_throttle = LoginThrottle()
# Tests hold this after a settings read and before the conditional write.
preference_write_gate: Callable[[], Awaitable[None]] | None = None
_PREFERENCE_ATTEMPTS = 8


class LoginIn(BaseModel):
    login: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class UserOut(BaseModel):
    id: str
    login: str
    is_admin: bool
    difficulty: Difficulty
    preferences: AccountPreferences


class SessionOut(BaseModel):
    user: UserOut
    csrf_token: str


class SettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    difficulty: Difficulty | None = None
    training: TrainingPreferences | None = None
    speech: SpeechPreferences | None = None
    training_auto_advance: StrictBool = False

    @model_validator(mode="after")
    def has_change(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("nothing to update")
        if "difficulty" in self.model_fields_set and self.difficulty is None:
            raise ValueError("invalid difficulty")
        return self


class ChangePasswordIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: str = Field(strict=True, min_length=1, max_length=256)
    new_password: str = Field(strict=True, min_length=12, max_length=128)


def _user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        login=user.login,
        is_admin=user.is_admin,
        difficulty=user.difficulty,
        preferences=public_preferences(user.preferences),
    )


def _session_out(user: User, csrf_token: str) -> SessionOut:
    return SessionOut(user=_user_out(user), csrf_token=csrf_token)


def _set_session_cookie(response: Response, token: str, settings: AppSettings) -> None:
    lifetime = timedelta(days=settings.session_days)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(lifetime.total_seconds()),
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


@router.post("/login")
async def login(body: LoginIn, response: Response, db: Db, settings: AppSettings) -> SessionOut:
    key = body.login.casefold()
    if throttle.blocked(key):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "too_many_attempts")
    user = await db.scalar(select(User).where(User.login == body.login))
    user_id = user.id if user else None
    verified_hash = user.password_hash if user else None
    # Do not hold a DB transaction or the event loop while Argon2 runs.
    await db.rollback()
    valid = await to_thread.run_sync(verify_password, verified_hash, body.password)
    if not valid or user_id is None:
        throttle.fail(key)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")

    token, csrf_token = new_token(), new_token()
    now = utcnow()
    inserted = await db.execute(
        insert(AuthSession).from_select(
            ["id", "user_id", "token_hash", "csrf_token", "created_at", "expires_at"],
            select(
                literal(new_id()),
                User.id,
                literal(token_hash(token)),
                literal(csrf_token),
                literal(now),
                literal(now + timedelta(days=settings.session_days)),
            ).where(User.id == user_id, User.password_hash == verified_hash),
        )
    )
    if inserted.rowcount != 1:  # type: ignore[attr-defined]
        await db.rollback()
        throttle.fail(key)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")
    await db.commit()
    user = await db.scalar(select(User).where(User.id == user_id))
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")
    throttle.reset(key)
    _set_session_cookie(response, token, settings)
    return _session_out(user, csrf_token)


@router.post("/change-password")
async def change_password(
    body: ChangePasswordIn, response: Response, auth: CurrentAuth, db: Db, settings: AppSettings
) -> SessionOut:
    user_id = auth.user.id
    session_id = auth.session.id
    old_hash = auth.user.password_hash
    if password_throttle.blocked(user_id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "too_many_attempts")
    await db.rollback()
    if not await to_thread.run_sync(verify_password, old_hash, body.current_password):
        password_throttle.fail(user_id)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_current_password")
    new_hash = await to_thread.run_sync(hash_password, body.new_password)
    valid_session = (
        select(AuthSession.id)
        .where(
            AuthSession.id == session_id,
            AuthSession.user_id == user_id,
            AuthSession.expires_at > utcnow(),
        )
        .exists()
    )
    changed = await db.execute(
        update(User)
        .where(User.id == user_id, User.password_hash == old_hash, valid_session)
        .values(password_hash=new_hash)
    )
    if changed.rowcount != 1:  # type: ignore[attr-defined]
        await db.rollback()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_authenticated")
    await db.execute(delete(AuthSession).where(AuthSession.user_id == user_id))
    token, csrf_token = new_token(), new_token()
    db.add(
        AuthSession(
            user_id=user_id,
            token_hash=token_hash(token),
            csrf_token=csrf_token,
            expires_at=utcnow() + timedelta(days=settings.session_days),
        )
    )
    await db.commit()
    user = await db.scalar(select(User).where(User.id == user_id))
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_authenticated")
    password_throttle.reset(user_id)
    _set_session_cookie(response, token, settings)
    return _session_out(user, csrf_token)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(auth: CurrentAuth, response: Response, db: Db) -> None:
    await db.execute(delete(AuthSession).where(AuthSession.id == auth.session.id))
    await db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")


@router.get("/me")
async def me(auth: CurrentAuth) -> SessionOut:
    return _session_out(auth.user, auth.session.csrf_token)


@router.put("/settings")
async def update_settings(body: SettingsIn, auth: CurrentAuth, db: Db) -> UserOut:
    fields = body.model_fields_set
    preference_write = bool(fields & {"training", "speech", "training_auto_advance"})
    for _attempt in range(_PREFERENCE_ATTEMPTS):
        await db.rollback()
        await db.refresh(auth.user)
        user_id = auth.user.id
        revision = auth.user.preferences_revision
        document = preference_document(auth.user.preferences)
        if "training" in fields:
            if body.training is None:
                document.pop("training", None)
            else:
                document["training"] = body.training.model_dump(mode="json")
        if "speech" in fields:
            if body.speech is None:
                document.pop("speech", None)
            else:
                document["speech"] = body.speech.model_dump(mode="json")
        if "training_auto_advance" in fields:
            document["training_auto_advance"] = body.training_auto_advance
        # Release the read snapshot before waiting, then write only if it is unchanged.
        await db.rollback()
        gate = preference_write_gate
        if gate is not None:
            await gate()
        # A preference write must not store the difficulty it happened to read.
        # Difficulty-only saves do not bump preferences_revision.
        values: dict[str, object] = {}
        conditions = [User.id == user_id]
        if "difficulty" in fields and body.difficulty is not None:
            values["difficulty"] = body.difficulty
        if preference_write:
            values["preferences"] = document or None
            values["preferences_revision"] = revision + 1
            conditions.append(User.preferences_revision == revision)
        try:
            result = await db.execute(update(User).where(*conditions).values(**values))
        except OperationalError:
            await db.rollback()
            continue
        if result.rowcount == 1:  # type: ignore[attr-defined]
            await db.commit()
            await db.refresh(auth.user)
            return _user_out(auth.user)
        await db.rollback()
    raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "preference_conflict")
