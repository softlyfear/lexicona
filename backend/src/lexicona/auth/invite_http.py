"""Four phase2B routes, reusing the bounded parser and authorization guards."""

from fastapi import APIRouter, Request, Response

from lexicona.auth import schema
from lexicona.auth.config import AuthConfig, token_hash
from lexicona.auth.dto import (
    AuthDTO,
    EmptyDTO,
    InviteCreatedDTO,
    InviteDTO,
    InviteListDTO,
    RegisterDTO,
    RevokeDTO,
)
from lexicona.auth.errors import AuthError, decision
from lexicona.auth.guards import cookie_digest, query_guard, unsafe_guard
from lexicona.auth.http import LoginPasswords, body, set_cookie, user_dto
from lexicona.auth.invites import Invites
from lexicona.auth.pagination import page, uuid4_string
from lexicona.auth.rates import Rates, peer
from lexicona.auth.sessions import Session, Sessions, User


def router(
    sessions: Sessions, config: AuthConfig, passwords: LoginPasswords, rates: Rates
) -> APIRouter:
    """Bind only the approved register and administrative invite operations."""
    routes = APIRouter(prefix="/api/v1")
    invites = Invites(sessions)

    @routes.post(
        "/auth/register",
        response_model=AuthDTO,
        status_code=201,
        operation_id="authRegister",
        responses=schema.responses(
            *schema.UNSAFE_ERRORS,
            "invite_invalid",
            "login_unavailable",
            "already_authenticated",
            "auth_busy",
            cookie=True,
            success_status=201,
        ),
        openapi_extra=schema.unsafe(RegisterDTO),
    )
    async def register(request: Request, response: Response) -> AuthDTO:
        context = decision(request)
        context.route = "/api/v1/auth/register"
        digest = cookie_digest(request, config)

        def authorize(current: Session) -> None:
            unsafe_guard(request, config, current, context, pre_auth=True)

        await sessions.check(context, digest, authorize)
        query_guard(request)
        data = await body(request, RegisterDTO)
        hashed = token_hash(data.invite_token)
        reservation = rates.register(hashed.hex(), peer(request))
        success = False
        try:
            await invites.candidate(context, hashed, data.login)
            encoded = await passwords.hash(data.password, context, reservation)
            user, prepared = await invites.register(
                context, digest, authorize, data, encoded
            )
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

    @routes.post(
        "/admin/invites",
        response_model=InviteCreatedDTO,
        status_code=201,
        operation_id="adminInviteCreate",
        responses=schema.responses(
            *schema.UNSAFE_ERRORS, "forbidden", success_status=201
        ),
        openapi_extra=schema.unsafe(EmptyDTO),
    )
    async def create(request: Request) -> InviteCreatedDTO:
        context = decision(request)
        context.route = "/api/v1/admin/invites"
        digest = cookie_digest(request, config)

        def authorize(current: Session, user: User) -> None:
            unsafe_guard(request, config, current, context, admin=user.role == "admin")

        await invites.check_admin(context, digest, authorize)
        query_guard(request)
        await body(request, EmptyDTO)
        invite, secret = await invites.create(
            context, digest, authorize, lambda user, retry: rates.create(user.id, retry)
        )
        return InviteCreatedDTO(invite=invite, invite_token=secret)

    @routes.get(
        "/admin/invites",
        response_model=InviteListDTO,
        operation_id="adminInviteList",
        responses=schema.responses("forbidden"),
        openapi_extra={
            "parameters": [
                {
                    "name": "limit",
                    "in": "query",
                    "required": False,
                    "schema": {
                        "type": "string",
                        "pattern": "^[1-9][0-9]{0,2}$",
                        "default": "50",
                    },
                    "description": (
                        "Decimal1..100; duplicate and unknown query keys are rejected."
                    ),
                },
                {
                    "name": "cursor",
                    "in": "query",
                    "required": False,
                    "schema": {"type": "string", "maxLength": 256},
                    "description": (
                        "Canonical unpadded base64url compact JSON "
                        "{v:1,created_at_us:integer,id:UUIDv4}; "
                        "descending tuple keyset."
                    ),
                },
            ]
        },
    )
    async def list_invites(request: Request) -> InviteListDTO:
        context = decision(request)
        context.route = "/api/v1/admin/invites"

        def authorize(current: Session, user: User) -> None:
            if user.role != "admin":
                raise AuthError("forbidden")

        return await invites.list(
            context, cookie_digest(request, config), authorize, lambda: page(request)
        )

    @routes.post(
        "/admin/invites/{invite_id}/revoke",
        response_model=InviteDTO,
        operation_id="adminInviteRevoke",
        responses=schema.responses(
            *schema.UNSAFE_ERRORS,
            "forbidden",
            "version_conflict",
            "invite_state_conflict",
        ),
        openapi_extra=schema.unsafe(RevokeDTO, invite_path=True),
    )
    async def revoke(request: Request) -> InviteDTO:
        invite_id: str = request.path_params["invite_id"]
        context = decision(request)
        context.route = "/api/v1/admin/invites/{invite_id}/revoke"
        digest = cookie_digest(request, config)

        def authorize(current: Session, user: User) -> None:
            unsafe_guard(request, config, current, context, admin=user.role == "admin")

        await invites.check_admin(context, digest, authorize)
        query_guard(request)
        try:
            uuid4_string(invite_id)
        except ValueError:
            raise AuthError(
                "validation_error", fields={"invite_id": ["Недопустимый формат."]}
            ) from None
        data = await body(request, RevokeDTO)
        return await invites.revoke(
            context, digest, authorize, invite_id, data.expected_version
        )

    return routes
