"""Strict header and origin guards; request values are never diagnostics."""

import hmac
import re
from urllib.parse import urlsplit

from starlette.requests import Request

from lexicona.auth.config import (
    PRINCIPAL_PATTERN,
    AuthConfig,
    token_hash,
)
from lexicona.auth.errors import AuthError, Decision
from lexicona.auth.sessions import Session


def single(request: Request, name: str, *, error: str) -> str | None:
    """Do not choose one value from duplicate or comma-joined security headers."""
    values = request.headers.getlist(name)
    if len(values) > 1 or any("," in value for value in values):
        raise AuthError(error)
    return values[0] if values else None


def origin_guard(
    request: Request, config: AuthConfig, *, issuance: bool = False
) -> None:
    """Origin is authoritative; fallback requires a confirmed exact origin."""
    origin = single(request, "origin", error="csrf_failed")
    if origin is not None:
        if origin != config.public_origin:
            raise AuthError("csrf_failed")
        return
    if issuance:
        site = single(request, "sec-fetch-site", error="csrf_failed")
        if site == "same-origin":
            return
        if site is not None:
            raise AuthError("csrf_failed")
    referer = single(request, "referer", error="csrf_failed")
    try:
        parsed = urlsplit(referer or "")
        if (
            parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or parsed.scheme
            not in ({"http", "https"} if issuance and config.development else {"https"})
            or not parsed.hostname
            or parsed.scheme + "://" + parsed.netloc != config.public_origin
        ):
            raise ValueError()
        _ = parsed.port
    except ValueError:
        raise AuthError("csrf_failed") from None


def cookie_digest(request: Request, config: AuthConfig) -> bytes | None:
    """Reject duplicate own cookies instead of trusting a last-value dictionary."""
    raw = request.headers.getlist("cookie")
    if sum(len(value.encode("latin-1")) for value in raw) > 8192:
        raise AuthError("request_headers_too_large")
    values = [
        part.strip().partition("=")[2]
        for header in raw
        for part in header.split(";")
        if part.strip().partition("=")[0] == config.cookie_name
    ]
    if len(values) > 1:
        raise AuthError("auth_required")
    if not values:
        return None
    try:
        return token_hash(values[0])
    except ValueError:
        return None


def query_guard(request: Request) -> None:
    """Implemented auth routes accept no query fields, including duplicates."""
    if request.query_params:
        raise AuthError(
            "validation_error", fields={"_request": ["Лишние поля запрещены."]}
        )


def unsafe_guard(
    request: Request,
    config: AuthConfig,
    current: Session,
    context: Decision,
    *,
    pre_auth: bool = False,
) -> None:
    """Preserve auth, CSRF, state, then expected-principal rejection order."""
    origin_guard(request, config)
    csrf = single(request, "x-csrf-token", error="csrf_failed")
    if csrf is None:
        raise AuthError("csrf_failed")
    try:
        token_hash(csrf)
    except ValueError:
        raise AuthError("csrf_failed") from None
    if not hmac.compare_digest(csrf, current.csrf):
        raise AuthError("csrf_failed")
    if pre_auth and current.user_id is not None:
        raise AuthError("already_authenticated")
    expected = single(
        request, "x-lexicona-expected-principal", error="principal_mismatch"
    )
    if (
        expected is None
        or re.fullmatch(PRINCIPAL_PATTERN, expected) is None
        or expected != current.principal
    ):
        raise AuthError("principal_mismatch")
