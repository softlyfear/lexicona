"""Account administration: lexicona-admin create-user | set-password | list-users."""

import argparse
import asyncio
import getpass
import sys

from sqlalchemy import delete, select

from lexicona.config import Settings
from lexicona.db import Database
from lexicona.models import AuthSession, User
from lexicona.security import hash_password

MIN_PASSWORD_LENGTH = 8


def _read_password() -> str:
    password = getpass.getpass("Password: ")
    if len(password) < MIN_PASSWORD_LENGTH:
        sys.exit(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")
    if getpass.getpass("Repeat: ") != password:
        sys.exit("Passwords do not match.")
    return password


async def _run(args: argparse.Namespace, database: Database) -> str:
    async with database.sessions() as db:
        if args.command == "list-users":
            users = await db.scalars(select(User).order_by(User.login))
            return "\n".join(f"{u.login}{' (admin)' if u.is_admin else ''}" for u in users)

        user = await db.scalar(select(User).where(User.login == args.login))
        if args.command == "create-user":
            if user is not None:
                sys.exit(f"User {args.login!r} already exists.")
            db.add(User(login=args.login, password_hash=args.password_hash, is_admin=args.admin))
            await db.commit()
            return f"Created {args.login!r}."

        if user is None:
            sys.exit(f"User {args.login!r} not found.")
        user.password_hash = args.password_hash
        # A new password logs the user out everywhere.
        await db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
        await db.commit()
        return f"Password updated for {args.login!r}."


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="lexicona-admin")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-user")
    create.add_argument("login")
    create.add_argument("--admin", action="store_true")
    commands.add_parser("set-password").add_argument("login")
    commands.add_parser("list-users")
    args = parser.parse_args(argv)

    if args.command in {"create-user", "set-password"}:
        args.password_hash = hash_password(_read_password())

    async def run() -> str:
        database = Database(Settings().database_url)
        try:
            return await _run(args, database)
        finally:
            await database.dispose()

    print(asyncio.run(run()))
