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
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,  # SQLite cannot ALTER most things in place
    )
    with context.begin_transaction():
        context.run_migrations()


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
