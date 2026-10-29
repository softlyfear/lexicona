from datetime import timedelta

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from lexicona.db import utcnow
from lexicona.deps import SESSION_COOKIE, AppSettings, CurrentAuth, Db
from lexicona.models import AuthSession, User
from lexicona.progress import Difficulty
from lexicona.security import LoginThrottle, new_token, token_hash, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])
throttle = LoginThrottle()


class LoginIn(BaseModel):
    login: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class UserOut(BaseModel):
    id: str
    login: str
    is_admin: bool
    difficulty: Difficulty


class SessionOut(BaseModel):
    user: UserOut
    csrf_token: str


class SettingsIn(BaseModel):
    difficulty: Difficulty


def _session_out(user: User, csrf_token: str) -> SessionOut:
    return SessionOut(
        user=UserOut(
            id=user.id, login=user.login, is_admin=user.is_admin, difficulty=user.difficulty
        ),
        csrf_token=csrf_token,
    )


@router.post("/login")
async def login(body: LoginIn, response: Response, db: Db, settings: AppSettings) -> SessionOut:
    key = body.login.casefold()
    if throttle.blocked(key):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "too_many_attempts")
    user = await db.scalar(select(User).where(User.login == body.login))
    if not verify_password(user.password_hash if user else None, body.password) or user is None:
        throttle.fail(key)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")
    throttle.reset(key)

    token, csrf_token = new_token(), new_token()
    lifetime = timedelta(days=settings.session_days)
    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=token_hash(token),
            csrf_token=csrf_token,
            expires_at=utcnow() + lifetime,
        )
    )
    await db.commit()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(lifetime.total_seconds()),
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
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
    auth.user.difficulty = body.difficulty
    await db.commit()
    return _session_out(auth.user, auth.session.csrf_token).user
