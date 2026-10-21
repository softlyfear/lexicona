"""Configured origins and canonical tokens are strict, never repaired."""

import pytest

from lexicona.auth.config import AuthConfig, token, token_hash


@pytest.mark.parametrize(
    "origin",
    [
        "http://example.test",
        "ftp://example.test",
        "https:///",
        "https://user:pass@example.test",
        "https://example.test/",
        "https://example.test?q=1",
        "https://example.test#fragment",
        "https://EXAMPLE.test",
        "https://example.test:443",
        "https://example.test:bad",
        "https://[invalid",
        "https://example.test:",
        "https://exa mple.test",
        "https://example.test\\evil",
        "https://example.test:08443",
    ],
)
def test_production_config_rejects_noncanonical_origin(origin: str) -> None:
    with pytest.raises(ValueError):
        AuthConfig(origin, development=False)


@pytest.mark.parametrize(
    "origin",
    ["https://example.test", "https://example.test:8443", "https://[::1]:8443"],
)
def test_canonical_production_origin(origin: str) -> None:
    config = AuthConfig(origin, development=False)
    assert config.cookie_name == "__Host-lexicona_session"


@pytest.mark.parametrize(
    "value",
    ["", "A" * 42, "A" * 44, "A" * 42 + "B", "A" * 43 + "=", " " + "A" * 43, "я" * 43],
)
def test_invalid_token_is_not_repaired(value: str) -> None:
    with pytest.raises(ValueError):
        token_hash(value)


def test_random_token_roundtrip() -> None:
    first, second = token(), token()
    assert first != second and len(token_hash(first)) == 32
