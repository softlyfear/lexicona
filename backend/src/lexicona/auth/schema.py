"""OpenAPI metadata for the actual routes and their manual bounded parser."""

from pydantic import BaseModel

from lexicona.auth.config import PRINCIPAL_PATTERN, TOKEN_PATTERN
from lexicona.auth.dto import UUID_PATTERN, AuthErrorDTO
from lexicona.auth.errors import ERRORS

COMMON_ERRORS = (
    "auth_required",
    "not_found",
    "method_not_allowed",
    "request_timeout",
    "validation_error",
    "rate_limited",
    "request_headers_too_large",
    "internal_error",
    "db_busy",
    "service_unavailable",
)
UNSAFE_ERRORS = (
    "invalid_request",
    "csrf_failed",
    "principal_mismatch",
    "invalid_json",
    "request_too_large",
    "unsupported_media_type",
)
HEADERS: dict[str, object] = {
    "Cache-Control": {
        "required": True,
        "schema": {"type": "string", "const": "no-store"},
        "description": "Always present on scoped application responses.",
    },
    "X-Request-ID": {
        "required": True,
        "schema": {"type": "string", "format": "uuid4"},
        "description": "Independent server UUIDv4; request header is never reflected.",
    },
    "X-Lexicona-Request-Principal": {
        "required": True,
        "schema": {"type": "string", "pattern": "^" + PRINCIPAL_PATTERN + "$"},
        "description": (
            "Actual request authorization decision, or deny-only anonymous. Login "
            "success remains anonymous; logout stamps the old principal. Never an "
            "expected-header echo."
        ),
    },
}


def responses(
    *extra: str, cookie: bool = False, success_status: int = 200
) -> dict[int | str, dict[str, object]]:
    """Bind exact status/code/message registry entries, including early errors."""
    success = dict(HEADERS)
    if cookie:
        success["Set-Cookie"] = {
            "schema": {"type": "string"},
            "description": (
                "Only after known committed issuance/rotation, never on errors or "
                "existing csrf reads. Production __Host-lexicona_session; explicit "
                "dev lexicona_session_dev."
            ),
        }
    result: dict[int | str, dict[str, object]] = {success_status: {"headers": success}}
    for code in (*COMMON_ERRORS, *extra):
        status, message = ERRORS[code]
        if status not in result:
            headers = dict(HEADERS)
            if status in {429, 503}:
                headers["Retry-After"] = {
                    "required": True,
                    "schema": {"type": "string", "pattern": "^[1-9][0-9]*$"},
                    "description": "Integer seconds; at least one.",
                }
            if status == 405:
                headers["Allow"] = {"required": True, "schema": {"type": "string"}}
            result[status] = {
                "model": AuthErrorDTO,
                "headers": headers,
                "x-error-codes": {},
            }
        codes = result[status]["x-error-codes"]
        assert isinstance(codes, dict)
        codes[code] = message
        result[status]["description"] = "; ".join(codes)
        result[status]["content"] = {
            "application/json": {
                "schema": {
                    "properties": {
                        "error": {
                            "properties": {
                                "code": {"enum": list(codes)},
                                "message": {"enum": list(codes.values())},
                            }
                        }
                    }
                }
            }
        }
    return result


def unsafe(model: type[BaseModel], *, invite_path: bool = False) -> dict[str, object]:
    """Document the existing parser without handing body reads to FastAPI."""
    return {
        "requestBody": {
            "required": True,
            "description": (
                "UTF-8 JSON object; actual streamed limit 16384 bytes, depth 16, "
                "read min(5s, remaining admission). Reject duplicate "
                "keys/non-finite values/invalid Unicode; forbid extra fields. "
                "Content-Encoding absent or identity only."
            ),
            "content": {"application/json": {"schema": model.model_json_schema()}},
        },
        "parameters": [
            *(
                [
                    {
                        "name": "invite_id",
                        "in": "path",
                        "required": True,
                        "schema": {
                            "type": "string",
                            "format": "uuid4",
                            "pattern": UUID_PATTERN,
                        },
                    }
                ]
                if invite_path
                else []
            ),
            {
                "name": "X-Lexicona-Expected-Principal",
                "in": "header",
                "required": True,
                "schema": {"type": "string", "pattern": "^" + PRINCIPAL_PATTERN + "$"},
                "description": (
                    "Checked after session, CSRF and login-state checks, again in "
                    "final write. Missing/malformed/duplicate/mismatch yields 412 "
                    "with no effects."
                ),
            },
            {
                "name": "X-CSRF-Token",
                "in": "header",
                "required": True,
                "schema": {"type": "string", "pattern": "^" + TOKEN_PATTERN + "$"},
                "description": (
                    "Synchronizer token of this session; "
                    "missing/malformed/duplicate/mismatch yields 403."
                ),
            },
            {
                "name": "Origin",
                "in": "header",
                "required": False,
                "schema": {"type": "string"},
                "description": (
                    "If present must equal configured public origin. Otherwise "
                    "exact-origin HTTPS Referer is required, even in dev. Never "
                    "trust Host or forwarded headers."
                ),
            },
            {
                "name": "Referer",
                "in": "header",
                "required": False,
                "schema": {"type": "string"},
                "description": (
                    "HTTPS fallback only when Origin is absent; no userinfo or "
                    "fragment."
                ),
            },
        ],
    }
