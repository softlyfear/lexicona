import asyncio

from alembic import context
from sqlalchemy.engine import Connection

from lexicona.config import Settings
from lexicona.db import Database
from lexicona.models import Base

config = context.config
target_metadata = Base.metadata


def _url() -> str:
    # Tests pass an explicit URL; otherwise use the application settings.
    url = config.get_main_option("sqlalchemy.url")
    return url or Settings().database_url


def _migrate(connection: Connection) -> None:
    # Batch recreation of a referenced SQLite table would otherwise cascade-delete
    # its children. Change the pragma outside any transaction, then lock writers and
    # run every migration plus the FK check atomically on this private connection.
    connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
    connection.commit()
    try:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,  # SQLite cannot ALTER most things in place
        )
        with context.begin_transaction():
            context.run_migrations()
        if connection.exec_driver_sql("PRAGMA foreign_key_check").first() is not None:
            raise RuntimeError("Migration would leave invalid foreign keys")
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        connection.commit()


async def _run_online() -> None:
    database = Database(_url())
    try:
        async with database.engine.connect() as connection:
            await connection.run_sync(_migrate)
    finally:
        await database.dispose()


if context.is_offline_mode():
    context.configure(url=_url(), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    asyncio.run(_run_online())
