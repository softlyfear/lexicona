"""Contract primitives shared by bootstrap and the future HTTP boundary."""

from datetime import UTC, datetime, timedelta, timezone

import pytest


def test_auth_value_contract() -> None:
    from lexicona.auth.values import display_name, epoch_microseconds, login, password

    assert login("Admin_01") == "admin_01"
    for value in ["aa", "a" * 33, " admin", "admin\n", "admіn", "ééé", "a-b"]:
        with pytest.raises(ValueError, match="Недопустимое значение"):
            login(value)
    assert display_name(" \u2003E\u0301  Name \t") == "É  Name"
    for value in [" ", "a" * 81, "a\nb", "a\ud800b", "a\x00b"]:
        with pytest.raises(ValueError, match="Недопустимое значение"):
            display_name(value)
    for value in [" " * 12, "\n" * 12, "😀" * 128, " a\u0301\n" * 4]:
        assert password(value) == value
    for value in ["a" * 11, "😀" * 129, "a" * 12 + "\udfff"]:
        with pytest.raises(ValueError, match="Недопустимое значение"):
            password(value)
    assert epoch_microseconds(datetime(1970, 1, 1, tzinfo=UTC)) == 0
    assert (
        epoch_microseconds(datetime(2026, 1, 1, 0, 0, 0, 123456, UTC))
        == 1767225600123456
    )
    assert (
        epoch_microseconds(datetime(1970, 1, 1, 3, tzinfo=timezone(timedelta(hours=3))))
        == 0
    )
    for timestamp in [datetime(2026, 1, 1), datetime(1969, 1, 1, tzinfo=UTC)]:
        with pytest.raises(ValueError, match="Недопустимое значение"):
            epoch_microseconds(timestamp)
