"""Closed HTTP models, with no ORM or validation-input serialization."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import UUID4, BaseModel, ConfigDict, Field, field_validator

from lexicona.auth import values
from lexicona.auth.config import TOKEN_PATTERN, token_hash

Token = Annotated[str, Field(pattern="^" + TOKEN_PATTERN + "$")]
UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
InviteUUID = Annotated[UUID4, Field(json_schema_extra={"pattern": UUID_PATTERN})]
Timestamp = Annotated[
    str,
    Field(
        pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$",
        json_schema_extra={"format": "date-time"},
    ),
]


class ClosedDTO(BaseModel):
    model_config = ConfigDict(
        extra="forbid", strict=True, json_schema_serialization_defaults_required=True
    )


class CsrfDTO(ClosedDTO):
    csrf_token: Token
    authenticated: bool


class LoginDTO(ClosedDTO):
    login: str = Field(
        json_schema_extra={
            "minLength": 3,
            "maxLength": 32,
            "pattern": "^[A-Za-z0-9_]{3,32}$",
        }
    )
    password: str = Field(
        repr=False,
        json_schema_extra={"minLength": 12, "maxLength": 128, "writeOnly": True},
    )

    @field_validator("login")
    @classmethod
    def canonical_login(cls, value: str) -> str:
        return values.login(value)

    @field_validator("password")
    @classmethod
    def valid_password(cls, value: str) -> str:
        return values.password(value)


class RegisterDTO(LoginDTO):
    invite_token: str = Field(
        repr=False,
        json_schema_extra={"pattern": "^" + TOKEN_PATTERN + "$", "writeOnly": True},
    )
    display_name: str = Field(json_schema_extra={"minLength": 1, "maxLength": 80})

    @field_validator("invite_token")
    @classmethod
    def valid_invite(cls, value: str) -> str:
        token_hash(value)
        return value

    @field_validator("display_name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        return values.display_name(value)


class RevokeDTO(ClosedDTO):
    expected_version: Annotated[int, Field(ge=1, le=9223372036854775807)]


class InviteDTO(ClosedDTO):
    id: InviteUUID
    created_by: InviteUUID | None
    created_at: Timestamp
    expires_at: Timestamp
    used_at: Timestamp | None
    revoked_at: Timestamp | None
    state: Literal["active", "used", "revoked", "expired"]
    version: Annotated[int, Field(ge=1, le=9223372036854775807)]


class InviteCreatedDTO(ClosedDTO):
    invite: InviteDTO
    invite_token: Token


class InviteListDTO(ClosedDTO):
    items: list[InviteDTO]
    next_cursor: str | None


class UserDTO(ClosedDTO):
    id: UUID = Field(
        json_schema_extra={
            "pattern": (
                "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            )
        }
    )
    login: str = Field(
        json_schema_extra={
            "minLength": 3,
            "maxLength": 32,
            "pattern": "^[a-z0-9_]{3,32}$",
        }
    )
    display_name: str = Field(json_schema_extra={"minLength": 1, "maxLength": 80})
    role: Literal["user", "admin"]
    version: Annotated[int, Field(ge=1, le=9223372036854775807)]


class EmptyDTO(ClosedDTO):
    """Unsafe empty-object input still rejects extra fields and scalar bodies."""


class LogoutDTO(ClosedDTO):
    csrf_token: Token
    authenticated: Literal[False] = False


class MeDTO(ClosedDTO):
    user: UserDTO


class AuthDTO(ClosedDTO):
    user: UserDTO
    csrf_token: Token


class AuthErrorDetail(ClosedDTO):
    code: str
    message: str
    fields: dict[str, list[str]] = Field(
        json_schema_extra={
            "propertyNames": {
                "enum": [
                    "login",
                    "display_name",
                    "password",
                    "invite_token",
                    "expected_version",
                    "invite_id",
                    "limit",
                    "cursor",
                    "_request",
                ]
            }
        }
    )
    request_id: UUID4


class AuthErrorDTO(ClosedDTO):
    error: AuthErrorDetail
