"""Protected first-administrator command; secrets never come from arguments."""

import argparse
import asyncio
import getpass
import logging
import os
import sys
import warnings
from collections.abc import Callable, Sequence
from typing import NoReturn

from lexicona.auth import values
from lexicona.auth.bootstrap import BootstrapError, BootstrapService
from lexicona.auth.passwords import PasswordService
from lexicona.database import DEFAULT_DATABASE_URL, Database


class SafeParser(argparse.ArgumentParser):
    """Never let argparse echo an unknown argument or invalid supplied value."""

    def error(self, message: str) -> NoReturn:
        raise ValueError("Проверьте введённые данные.")


class InvalidInput(Exception):
    """Invalid protected input, distinct from runtime/database ValueError."""


class Arguments(argparse.Namespace):
    command: str
    login: str
    display_name: str


def protected_password() -> str:
    """Read exactly two hidden TTY inputs; refuse insecure getpass fallback."""
    if not sys.stdin.isatty():
        raise ValueError("Проверьте введённые данные.")
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        first = getpass.getpass("Пароль: ")
        second = getpass.getpass("Повторите пароль: ")
    if first != second:
        raise ValueError("Проверьте введённые данные.")
    return values.password(first)


async def _run(args: Arguments, secret: str | None) -> None:
    database = Database(os.environ.get("LEXICONA_DATABASE_URL", DEFAULT_DATABASE_URL))
    passwords = PasswordService()

    async def operate() -> None:
        service = BootstrapService(database, passwords)
        await service.check(args.login)
        if secret is not None:
            await service.create(
                args.login,
                args.display_name,
                secret,
                deadline=asyncio.get_running_loop().time() + 12,
            )

    # Own the task before any read/write UoW starts. Forward cancellation once
    # to stop business submissions; further cancels must not interrupt the
    # driver's active-operation invalidation/close before the owner joins it.
    operation = asyncio.create_task(operate())
    try:
        try:
            await asyncio.shield(operation)
        finally:
            if not operation.done():
                operation.cancel()
            while not operation.done():
                try:
                    await asyncio.shield(operation)
                except asyncio.CancelledError:
                    pass
            operation.result()
    finally:

        async def close() -> None:
            try:
                await passwords.aclose()
            finally:
                await database.dispose()

        # Repeated outer cancellation must not skip DB disposal while threads
        # join, nor interrupt disposal and leave pooled connections alive.
        cleanup = asyncio.create_task(close())
        cancelled = False
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                cancelled = True
        cleanup.result()
        if cancelled:
            raise asyncio.CancelledError()


def main(
    argv: Sequence[str] | None = None, *, prompt: Callable[[], str] = protected_password
) -> int:
    """Run bootstrap with static diagnostics; zero means a known committed result."""
    parser = SafeParser(prog="lexicona.operations.admin")
    commands = parser.add_subparsers(dest="command", required=True)
    bootstrap = commands.add_parser("bootstrap")
    bootstrap.add_argument("--login", required=True)
    bootstrap.add_argument("--display-name", required=True)
    try:
        args = parser.parse_args(argv, namespace=Arguments())
        args.login = values.login(args.login)
        args.display_name = values.display_name(args.display_name)
    except ValueError:
        print("Проверьте введённые данные.", file=sys.stderr)
        return 2
    try:
        # Driver DEBUG logging can bypass SQLAlchemy's hide_parameters.
        logging.getLogger("aiosqlite").setLevel(logging.WARNING)
        logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
        asyncio.run(_run(args, None))
        # getpass must run outside asyncio.run: its SIGINT handler only cancels
        # an async task and cannot interrupt a synchronous terminal read.
        try:
            secret = values.password(prompt())
        except (ValueError, getpass.GetPassWarning):
            raise InvalidInput() from None
        asyncio.run(_run(args, secret))
    except (KeyboardInterrupt, EOFError, asyncio.CancelledError):
        print("Операция отменена.", file=sys.stderr)
        return 130
    except BootstrapError as error:
        print(str(error), file=sys.stderr)
        return error.exit_code
    except InvalidInput:
        print("Проверьте введённые данные.", file=sys.stderr)
        return 2
    except Exception:
        # Unknown commit outcomes are failures, never assertions of rollback/retries.
        print("База данных не готова.", file=sys.stderr)
        return 5
    print("Первый администратор создан.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
