"""Actual implemented auth routes only; no register/invite placeholders."""

import asyncio
import base64
import binascii
import json
import secrets
from datetime import UTC, datetime, timedelta
from time import monotonic
from typing import cast
from uuid import UUID

from argon2 import Type, extract_parameters
from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ValidationError
from starlette.requests import ClientDisconnect
from starlette.types import ASGIApp, Receive, Scope, Send

from lexicona.auth import schema
from lexicona.auth.config import AuthConfig
from lexicona.auth.dto import (
    AuthDTO,
    CsrfDTO,
    EmptyDTO,
    LoginDTO,
    LogoutDTO,
    MeDTO,
    UserDTO,
)
from lexicona.auth.errors import AuthError, Decision, decision
from lexicona.auth.guards import (
    cookie_digest,
    origin_guard,
    query_guard,
    single,
    unsafe_guard,
)
from lexicona.auth.passwords import (
    Hasher,
    PasswordBusy,
    PasswordService,
    PasswordUnavailable,
)
from lexicona.auth.rates import Rates, Reservation, peer
from lexicona.auth.sessions import Session, Sessions, User


class RejectScopedSlashes:
    """Reject noncanonical scoped paths before the router can echo their URL."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # AuthBoundary owns admission/errors; unrelated legacy routing is untouched.
        if "auth_decision" in scope and scope["path"].endswith("/"):
            raise AuthError("not_found")
        await self.app(scope, receive, send)


def set_cookie(
    response: Response,
    config: AuthConfig,
    secret: str,
    *,
    authenticated: bool,
    absolute: int,
) -> None:
    """Only known committed transitions may write the browser credential."""
    age = 2592000 if authenticated else 1800
    response.set_cookie(
        config.cookie_name,
        secret,
        max_age=age,
        expires=datetime(1970, 1, 1, tzinfo=UTC) + timedelta(microseconds=absolute),
        path="/",
        secure=not config.development,
        httponly=True,
        samesite="lax",
    )


class LoginPasswords:
    """One lifespan-owned executor and random dummy PHC, never per request."""

    def __init__(self, hasher: Hasher | None = None) -> None:
        self._hasher = hasher
        self.service: PasswordService | None = None
        self.dummy: str | None = None

    async def start(self) -> None:
        """Prepare dummy work off-loop before admitting HTTP auth traffic."""
        self.service = PasswordService(self._hasher)
        self.dummy = await self.service.hash(
            secrets.token_urlsafe(32), deadline=monotonic() + 12
        )

    async def close(self) -> None:
        """Join all submitted native hash work before releasing app resources."""
        if self.service is not None:
            await self.service.aclose()
        self.service = None
        self.dummy = None

    async def hash(
        self, password: str, context: Decision, reservation: Reservation
    ) -> str:
        """Use the native submission completion seam for registration hashing.

        PasswordService.hash has no completion argument; its existing generic
        native submission method does. Do not release on coroutine timeout.
        """
        service = self.service
        if service is None:
            raise AuthError("service_unavailable")
        reservation.start()
        try:
            return cast(
                str,
                await service._submit(
                    lambda: service._hasher.hash(password),
                    context.deadline,
                    reservation.completed,
                ),
            )
        except PasswordBusy:
            raise AuthError("auth_busy") from None
        except PasswordUnavailable:
            raise AuthError("service_unavailable") from None

    async def verify(
        self,
        candidate: User | None,
        password: str,
        context: Decision,
        reservation: Reservation,
    ) -> User:
        """Exactly one real or dummy verify, with one generic credential failure."""
        if self.service is None or self.dummy is None:
            raise AuthError("service_unavailable")
        usable = candidate is not None and valid_phc(candidate.encoded)
        encoded = candidate.encoded if candidate is not None and usable else self.dummy
        reservation.start()
        try:
            matches = await self.service.verify(
                encoded,
                password,
                deadline=context.deadline,
                on_complete=reservation.completed,
            )
        except PasswordBusy:
            raise AuthError("auth_busy") from None
        except PasswordUnavailable:
            raise AuthError("service_unavailable") from None
        if not matches or not usable or candidate is None or not candidate.active:
            raise AuthError("invalid_credentials")
        return candidate


def valid_phc(encoded: str) -> bool:
    """Reject malformed or unbounded stored profiles before native verification."""
    if len(encoded) > 512:
        return False
    try:
        parameters = extract_parameters(encoded)
        parts = encoded.split("$")
        for part in parts[-2:]:
            base64.b64decode(part + "=" * (-len(part) % 4), validate=True)
        return (
            parameters.type,
            parameters.version,
            parameters.memory_cost,
            parameters.time_cost,
            parameters.parallelism,
            parameters.salt_len,
            parameters.hash_len,
        ) == (Type.ID, 19, 65536, 3, 1, 16, 32)
    except (ValueError, binascii.Error):
        return False


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Use the standard JSON parser while rejecting duplicate keys."""
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def finite_only(value: str) -> object:
    """JSON extension constants are not accepted on this boundary."""
    raise ValueError()


def bounded_depth(value: object, level: int = 0) -> None:
    """Bound nested containers after the byte-bounded standard parser."""
    if isinstance(value, (dict, list)):
        if level >= 16:
            raise ValueError()
        children = value.values() if isinstance(value, dict) else value
        for child in children:
            bounded_depth(child, level + 1)


async def body[Model: BaseModel](request: Request, model: type[Model]) -> Model:
    """Read actual bytes under the one admission deadline; never echo input."""
    context = decision(request)
    content_type = single(request, "content-type", error="unsupported_media_type")
    encoding = single(request, "content-encoding", error="unsupported_media_type")
    if (
        content_type is None
        or content_type.split(";", 1)[0].strip().lower() != "application/json"
        or encoding not in {None, "identity"}
    ):
        raise AuthError("unsupported_media_type")
    payload = bytearray()
    try:
        async with asyncio.timeout_at(min(monotonic() + 5, context.deadline)):
            async for chunk in request.stream():
                if len(payload) + len(chunk) > 16384:
                    raise AuthError("request_too_large")
                payload.extend(chunk)
    except TimeoutError:
        raise AuthError("request_timeout") from None
    except ClientDisconnect:
        raise AuthError("invalid_request") from None
    try:
        data: object = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=unique_object,
            parse_constant=finite_only,
        )
        bounded_depth(data)
    except (ValueError, RecursionError):
        raise AuthError("invalid_json") from None
    try:
        return model.model_validate(data)
    except ValidationError as error:
        fields: dict[str, list[str]] = {}
        for item in error.errors(
            include_input=False, include_context=False, include_url=False
        ):
            location = item["loc"]
            field = (
                location[0]
                if location
                and location[0]
                in {
                    "login",
                    "password",
                    "display_name",
                    "invite_token",
                    "expected_version",
                }
                else "_request"
            )
            code = item["type"]
            message = (
                "Обязательное поле."
                if code == "missing"
                else "Лишние поля запрещены."
                if code == "extra_forbidden"
                else "Неверный тип."
                if code.endswith("_type")
                else "Недопустимое значение."
            )
            messages = fields.setdefault(str(field), [])
            if message not in messages:
                messages.append(message)
        raise AuthError("validation_error", fields=fields) from None


def user_dto(user: User) -> UserDTO:
    """Only the frozen five safe fields cross the boundary."""
    return UserDTO(
        id=UUID(user.id),
        login=user.login,
        display_name=user.display_name,
        role=user.role,
        version=user.version,
    )


def router(
    sessions: Sessions, config: AuthConfig, rates: Rates, passwords: LoginPasswords
) -> APIRouter:
    """Bind explicit per-app services, without module-global auth state."""
    routes = APIRouter(prefix="/api/v1/auth")

    @routes.get(
        "/csrf",
        response_model=CsrfDTO,
        operation_id="authCsrf",
        responses=schema.responses("csrf_failed", cookie=True),
        description=(
            "Confirmed-origin issuance or reuse of the existing CSRF token. GET "
            "body is never read. No query fields. Existing A may CAS-touch; "
            "existing P never slides. Cookie is not rewritten on reuse."
        ),
    )
    async def csrf(request: Request, response: Response) -> CsrfDTO:
        context = decision(request)
        context.route = "/api/v1/auth/csrf"
        origin_guard(request, config, issuance=True)
        query_guard(request)
        current, prepared = await sessions.csrf(
            context,
            cookie_digest(request, config),
            lambda: rates.issuance.take(peer(request)),
        )
        context.principal = current.principal
        if prepared is not None:
            set_cookie(
                response,
                config,
                prepared.secret,
                authenticated=False,
                absolute=current.absolute,
            )
        return CsrfDTO(
            csrf_token=current.csrf, authenticated=current.user_id is not None
        )

    @routes.post(
        "/login",
        response_model=AuthDTO,
        operation_id="authLogin",
        responses=schema.responses(
            *schema.UNSAFE_ERRORS,
            "auth_busy",
            "invalid_credentials",
            "already_authenticated",
            cookie=True,
        ),
        openapi_extra=schema.unsafe(LoginDTO),
        description=(
            "Only valid pre-auth may authenticate. Atomic P revoke and new A "
            "creation; request principal remains anonymous. No automatic retry. No "
            "query fields."
        ),
    )
    async def login(request: Request, response: Response) -> AuthDTO:
        context = decision(request)
        context.route = "/api/v1/auth/login"
        digest = cookie_digest(request, config)

        def authorize(current: Session) -> None:
            unsafe_guard(request, config, current, context, pre_auth=True)

        await sessions.check(context, digest, authorize)
        query_guard(request)
        data = await body(request, LoginDTO)
        reservation = rates.login(data.login, peer(request))
        success = False
        try:
            candidate = await sessions.candidate(context, data.login)
            candidate = await passwords.verify(
                candidate, data.password, context, reservation
            )
            user, prepared = await sessions.login(context, digest, authorize, candidate)
            set_cookie(
                response,
                config,
                prepared.secret,
                authenticated=True,
                absolute=prepared.absolute,
            )
            result = AuthDTO(user=user_dto(user), csrf_token=prepared.csrf)
            success = True
            return result
        finally:
            reservation.finish(success=success)

    @routes.get(
        "/me",
        response_model=MeDTO,
        operation_id="authMe",
        responses=schema.responses(),
        description=(
            "Only the active user of the validated cookie, from the same DB "
            "decision as the principal stamp. GET body is never read. No query "
            "fields. No cookie write; metadata touch at five-minute boundary."
        ),
    )
    async def me(request: Request) -> MeDTO:
        context = decision(request)
        context.route = "/api/v1/auth/me"
        user = await sessions.me(
            context, cookie_digest(request, config), lambda: query_guard(request)
        )
        return MeDTO(user=user_dto(user))

    @routes.post(
        "/logout",
        response_model=LogoutDTO,
        operation_id="authLogout",
        responses=schema.responses(*schema.UNSAFE_ERRORS, cookie=True),
        openapi_extra=schema.unsafe(EmptyDTO),
        description=(
            "Atomically revoke valid A or P and create a new P. Stamp is the old "
            "request principal. Expired or replayed old credential is 401, not "
            "success. No automatic retry. No query fields."
        ),
    )
    async def logout(request: Request, response: Response) -> LogoutDTO:
        context = decision(request)
        context.route = "/api/v1/auth/logout"
        digest = cookie_digest(request, config)

        def authorize(current: Session) -> None:
            unsafe_guard(request, config, current, context)

        await sessions.check(context, digest, authorize)
        query_guard(request)
        await body(request, EmptyDTO)
        prepared = await sessions.logout(
            context,
            digest,
            authorize,
            lambda: rates.issuance.take(peer(request)),
        )
        set_cookie(
            response,
            config,
            prepared.secret,
            authenticated=False,
            absolute=prepared.absolute,
        )
        return LogoutDTO(csrf_token=prepared.csrf, authenticated=False)

    return routes
