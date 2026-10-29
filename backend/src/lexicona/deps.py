import secrets
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from lexicona.config import Settings
from lexicona.db import Database, utcnow
from lexicona.models import AuthSession, User
from lexicona.security import token_hash

SESSION_COOKIE = "lexicona_session"
CSRF_HEADER = "X-CSRF-Token"
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    database: Database = request.app.state.db
    async for session in database.session():
        yield session


Db = Annotated[AsyncSession, Depends(get_db)]
AppSettings = Annotated[Settings, Depends(get_settings)]


@dataclass(frozen=True, slots=True)
class Auth:
    user: User
    session: AuthSession


async def current_auth(request: Request, db: Db) -> Auth:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        session = await db.scalar(
            select(AuthSession).where(
                AuthSession.token_hash == token_hash(token),
                AuthSession.expires_at > utcnow(),
            )
        )
        if session is not None:
            if request.method not in _SAFE_METHODS and not secrets.compare_digest(
                request.headers.get(CSRF_HEADER, ""), session.csrf_token
            ):
                raise HTTPException(status.HTTP_403_FORBIDDEN, "csrf_failed")
            return Auth(user=session.user, session=session)
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_authenticated")


CurrentAuth = Annotated[Auth, Depends(current_auth)]
