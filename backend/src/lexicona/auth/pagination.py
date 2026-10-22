"""Bounded canonical invite keysets; positions are never authorization inputs."""

import base64
import json
import re
from dataclasses import dataclass
from uuid import UUID

from starlette.requests import Request

from lexicona.auth.errors import AuthError


def uuid4_string(value: str) -> str:
    """Do not repair UUID case, braces, missing dashes or a different version."""
    parsed = UUID(value)
    if parsed.version != 4 or str(parsed) != value:
        raise ValueError()
    return value


def encode(created: int, id: str) -> str:
    """One compact ordered JSON representation and unpadded base64url encoding."""
    raw = json.dumps(
        {"v": 1, "created_at_us": created, "id": id}, separators=(",", ":")
    ).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode(value: str) -> tuple[int, str]:
    """Validate shape, strict integer and exact round trip; no whitespace repair."""
    try:
        if len(value) > 256 or re.fullmatch(r"[A-Za-z0-9_-]+", value) is None:
            raise ValueError()
        data = json.loads(
            base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode("utf-8")
        )
        if not isinstance(data, dict) or set(data) != {"v", "created_at_us", "id"}:
            raise ValueError()
        version, created, id = data["v"], data["created_at_us"], data["id"]
        if (
            type(version) is not int
            or version != 1
            or type(created) is not int
            or not 0 <= created <= 9223372036854775807
            or not isinstance(id, str)
        ):
            raise ValueError()
        uuid4_string(id)
        if encode(created, id) != value:
            raise ValueError()
        return created, id
    except (ValueError, UnicodeError):
        raise AuthError(
            "validation_error", fields={"cursor": ["Недопустимый формат."]}
        ) from None


@dataclass(frozen=True)
class Page:
    limit: int = 50
    position: tuple[int, str] | None = None


def page(request: Request) -> Page:
    """Reject duplicate and unknown keys before choosing any query value."""
    params = request.query_params
    for key in params:
        if key not in {"limit", "cursor"}:
            raise AuthError(
                "validation_error", fields={"_request": ["Лишние поля запрещены."]}
            )
        if len(params.getlist(key)) != 1:
            raise AuthError(
                "validation_error", fields={key: ["Недопустимое значение."]}
            )
    limit = params.get("limit", "50")
    if re.fullmatch(r"[1-9][0-9]{0,2}", limit) is None or int(limit) > 100:
        raise AuthError(
            "validation_error", fields={"limit": ["Недопустимое значение."]}
        )
    return Page(int(limit), decode(params["cursor"]) if "cursor" in params else None)
