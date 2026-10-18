from pathlib import Path
from stat import S_IMODE

import pytest
from sqlalchemy import text


@pytest.mark.parametrize(
    "url",
    [
        "sqlite+aiosqlite:///:memory:",
        "sqlite+aiosqlite://",
        "sqlite:///relative.sqlite3",
        "postgresql+asyncpg://localhost/example",
        "sqlite+aiosqlite:///a.sqlite3?uri=true",
    ],
)
def test_only_local_file_sqlite_is_supported(url: str) -> None:
    from lexicona.database import Database

    with pytest.raises(ValueError, match="file-backed sqlite\\+aiosqlite"):
        Database(url)


async def test_file_database_configuration(tmp_path: Path) -> None:
    from lexicona.database import Database

    directory = tmp_path / "private"
    database = Database(f"sqlite+aiosqlite:///{directory / 'app.sqlite3'}")
    try:
        async with database.unit_of_work() as session:
            assert await session.scalar(text("PRAGMA journal_mode")) == "wal"
            assert await session.scalar(text("PRAGMA foreign_keys")) == 1
            assert await session.scalar(text("PRAGMA busy_timeout")) == 5000
            assert session.in_transaction()
        assert S_IMODE(directory.stat().st_mode) == 0o700
    finally:
        await database.dispose()
