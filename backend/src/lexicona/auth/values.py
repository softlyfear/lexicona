"""Validated contract primitives, without implicit secret transformations."""

import re
import unicodedata
from datetime import UTC, datetime


def login(value: str) -> str:
    """Canonicalize ASCII case only, then require the complete login grammar."""
    value = value.translate(
        str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
    )
    if re.fullmatch(r"[a-z0-9_]{3,32}", value) is None:
        raise ValueError("Недопустимое значение.")
    return value


def display_name(value: str) -> str:
    """NFC/outer-trim a display name, preserving internal whitespace."""
    value = unicodedata.normalize("NFC", value).strip()
    if not 1 <= len(value) <= 80 or any(
        unicodedata.category(c) in {"Cc", "Cs"} for c in value
    ):
        raise ValueError("Недопустимое значение.")
    return value


def password(value: str) -> str:
    """Accept 12–128 Unicode scalars verbatim, including whitespace/newlines."""
    if not 12 <= len(value) <= 128 or any(
        unicodedata.category(c) == "Cs" for c in value
    ):
        raise ValueError("Недопустимое значение.")
    return value


def epoch_microseconds(value: datetime) -> int:
    """Convert an aware timestamp using integer arithmetic, never floats."""
    if value.utcoffset() is None:
        raise ValueError("Недопустимое значение.")
    delta = value.astimezone(UTC) - datetime(1970, 1, 1, tzinfo=UTC)
    result = (delta.days * 86400 + delta.seconds) * 1000000 + delta.microseconds
    if not 0 <= result <= 9223372036854775807:
        raise ValueError("Недопустимое значение.")
    return result
