"""Scoped ASGI ownership: safe errors, decision stamp and cancellation join."""

import asyncio
import logging
import sqlite3
from collections.abc import Awaitable
from time import monotonic

from sqlalchemy.exc import DBAPIError, SQLAlchemyError
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from lexicona.auth.errors import AuthError, Decision, error_response
from lexicona.auth.rates import Rates, peer

logger = logging.getLogger("lexicona.http")


async def owned[T](work: Awaitable[T]) -> T:
    """Forward cancellation once, then join submitted native termination."""
    operation = asyncio.ensure_future(work)
    try:
        return await asyncio.shield(operation)
    finally:
        if not operation.done() and not operation.cancelling():
            operation.cancel()
        while not operation.done():
            try:
                await asyncio.shield(operation)
            except asyncio.CancelledError:
                pass
        operation.result()


class AuthBoundary:
    """No second principal lookup at response time; unknown routes stay anonymous."""

    def __init__(self, app: ASGIApp, rates: Rates) -> None:
        self.app = app
        self.rates = rates

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not any(
            scope["path"] == prefix or scope["path"].startswith(prefix + "/")
            for prefix in ("/api/v1/auth", "/api/v1/admin")
        ):
            await self.app(scope, receive, send)
            return
        start = monotonic()
        context = Decision(start + 12)
        scope["auth_decision"] = context
        started = False
        owner = asyncio.current_task()
        assert owner is not None

        async def stamped(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                if owner.cancelling():
                    raise asyncio.CancelledError()
                if message["status"] < 400 and monotonic() >= context.deadline:
                    raise AuthError("request_timeout")
                started = True
                message["headers"] = list(message.get("headers", [])) + [
                    (b"cache-control", b"no-store"),
                    (b"x-request-id", context.request_id.encode("ascii")),
                    (
                        b"x-lexicona-request-principal",
                        context.principal.encode("ascii"),
                    ),
                ]
                logger.info(
                    "request",
                    extra={
                        "request_id": context.request_id,
                        "method": scope["method"],
                        "route": context.route,
                        "status": message["status"],
                        "duration": monotonic() - start,
                    },
                )
            await send(message)

        async def operate() -> None:
            try:
                self.rates.general.take(peer(Request(scope)))
                await self.app(scope, receive, stamped)
            except AuthError as error:
                if started:
                    raise
                await error_response(error, context)(scope, receive, stamped)
            except TimeoutError:
                if started:
                    raise
                await error_response(AuthError("db_busy"), context)(
                    scope, receive, stamped
                )
            except (OSError, SQLAlchemyError) as error:
                if started:
                    raise
                busy = isinstance(error, DBAPIError) and getattr(
                    error.orig, "sqlite_errorcode", 0
                ) & 255 in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}
                await error_response(
                    AuthError("db_busy" if busy else "service_unavailable"), context
                )(scope, receive, stamped)
            except Exception:
                if started:
                    raise
                await error_response(AuthError("internal_error"), context)(
                    scope, receive, stamped
                )

        await owned(operate())
