"""Explicit async migrations; runtime startup never calls this module."""

import asyncio
import os

from alembic import context
from sqlalchemy import Connection

from lexicona.database import DEFAULT_DATABASE_URL, Database


def run_migrations(connection: Connection) -> None:
    """Use the same real transaction control as application connections."""
    context.configure(connection=connection, transactional_ddl=True)
    with context.begin_transaction():
        context.run_migrations()


async def run_online(url: str) -> None:
    """Apply migrations with guaranteed connection-pool cleanup."""
    database = Database(url)
    try:
        async with database.engine.connect() as connection:
            await connection.run_sync(run_migrations)
    finally:
        await database.dispose()


url = os.environ.get(
    "LEXICONA_DATABASE_URL",
    context.config.get_main_option("sqlalchemy.url", DEFAULT_DATABASE_URL),
)
if context.is_offline_mode():
    context.configure(url=url, literal_binds=True, transactional_ddl=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    asyncio.run(run_online(url))
