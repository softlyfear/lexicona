"""Explicit auth configuration and canonical token primitives."""

import base64
import hashlib
import re
import secrets
from dataclasses import dataclass
from urllib.parse import urlsplit

TOKEN_PATTERN = r"[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]"
PRINCIPAL_PATTERN = (
    r"(?:anonymous|user:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}"
    r"-[89ab][0-9a-f]{3}-[0-9a-f]{12})"
)


def token() -> str:
    """Create exactly 256 random bits in the frozen wire representation."""
    return secrets.token_urlsafe(32)


def token_hash(value: str) -> bytes:
    """Hash decoded random bytes, not their wire representation."""
    if re.fullmatch(TOKEN_PATTERN, value) is None:
        raise ValueError("Invalid token")
    return hashlib.sha256(base64.urlsafe_b64decode(value + "=")).digest()


@dataclass(frozen=True)
class AuthConfig:
    """One configured public origin; never derived from Host/forwarded headers."""

    public_origin: str = "http://127.0.0.1:5173"
    development: bool = True

    def __post_init__(self) -> None:
        origin = urlsplit(self.public_origin)
        host = origin.hostname or ""
        authority = "[" + host + "]" if ":" in host else host
        if origin.port is not None:
            authority += ":" + str(origin.port)
        if (
            origin.scheme not in {"http", "https"}
            or not origin.hostname
            or origin.username is not None
            or origin.password is not None
            or origin.path
            or origin.query
            or origin.fragment
            or origin.geturl() != self.public_origin
            or self.public_origin != self.public_origin.lower()
            or origin.netloc != authority
            or re.fullmatch(r"[a-z0-9.\-:\[\]]+", origin.netloc) is None
            or origin.port == {"http": 80, "https": 443}[origin.scheme]
            or (not self.development and origin.scheme != "https")
        ):
            raise ValueError("Invalid public origin")

    @property
    def cookie_name(self) -> str:
        """Production and explicit development never share a credential name."""
        return "lexicona_session_dev" if self.development else "__Host-lexicona_session"
