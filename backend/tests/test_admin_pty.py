"""Real protected PTYs and independent CLI processes on disposable file WAL DBs."""

import os
import select
import signal
import sqlite3
import subprocess
import sys
import termios
from contextlib import closing
from pathlib import Path
from time import monotonic

import pytest
from test_auth_schema import migrate


class Terminal:
    def __init__(self, path: Path, login: str = "ADMIN") -> None:
        self.master, self.slave = os.openpty()
        env = os.environ.copy()
        env["LEXICONA_DATABASE_URL"] = f"sqlite+aiosqlite:///{path}"
        self.process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "lexicona.operations.admin",
                "bootstrap",
                "--login",
                login,
                "--display-name",
                " E\u0301  Имя ",
            ],
            stdin=self.slave,
            stdout=self.slave,
            stderr=self.slave,
            env=env,
            start_new_session=True,
        )
        self.output = b""

    def expect(self, text: str) -> None:
        target = text.encode()
        end = monotonic() + 5
        while target not in self.output:
            if monotonic() >= end:
                pytest.fail("Protected CLI prompt missing (output redacted)")
            if select.select([self.master], [], [], 0.05)[0]:
                self.output += os.read(self.master, 65536)

    def send(self, secret: str) -> None:
        assert not termios.tcgetattr(self.slave)[3] & termios.ECHO
        secret_in_argv = (
            secret.encode() in Path(f"/proc/{self.process.pid}/cmdline").read_bytes()
        )
        assert not secret_in_argv, "Protected input appeared in child argv"
        os.write(self.master, secret.encode() + b"\n")

    def finish(self) -> int:
        code = self.process.wait(timeout=10)
        while select.select([self.master], [], [], 0)[0]:
            self.output += os.read(self.master, 65536)
        return code

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        os.close(self.master)
        os.close(self.slave)


def counts(path: Path) -> tuple[int, int]:
    with closing(sqlite3.connect(path)) as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone() == ("wal",)
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        return (
            connection.execute("SELECT count(*) FROM users").fetchone()[0],
            connection.execute("SELECT count(*) FROM user_settings").fetchone()[0],
        )


@pytest.mark.parametrize("same", [True, False])
def test_two_protected_processes_bootstrap_exactly_one_admin(
    tmp_path: Path, same: bool
) -> None:
    import secrets

    path = tmp_path / "race.sqlite3"
    migrate(path)
    first, second = Terminal(path), Terminal(path, "admin" if same else "another")
    secret = "  😀Ée\u0301" + secrets.token_urlsafe(24) + " "
    try:
        for terminal in [first, second]:
            terminal.expect("Пароль: ")
            terminal.send(secret)
            terminal.expect("Повторите пароль: ")
        for terminal in [first, second]:
            terminal.send(secret)
        outcomes = sorted([first.finish(), second.finish()])
        assert outcomes == [0, 3 if same else 4]
        assert counts(path) == (1, 1)
        from lexicona.auth.passwords import ArgonHasher

        with closing(sqlite3.connect(path)) as connection:
            login, name, role, active, encoded = connection.execute(
                "SELECT login,display_name,role,is_active,password_hash FROM users"
            ).fetchone()
        assert login in {"admin", "another"}
        assert (name, role, active) == ("É  Имя", "admin", 1)
        hasher = ArgonHasher()
        verified_verbatim = hasher.verify(encoded, secret)
        accepted_trimmed = hasher.verify(encoded, secret.strip())
        accepted_normalized = hasher.verify(encoded, secret.replace("e\u0301", "é"))
        assert verified_verbatim and not accepted_trimmed and not accepted_normalized
        for terminal in [first, second]:
            assert secret.encode() not in terminal.output
            assert b"$argon2" not in terminal.output
            assert b"Traceback" not in terminal.output
        assert (
            sum(
                "Первый администратор создан.".encode() in terminal.output
                for terminal in [first, second]
            )
            == 1
        )
    finally:
        first.close()
        second.close()


@pytest.mark.parametrize("failure", ["mismatch", "eof", "cancel", "format"])
def test_protected_prompt_failures_leave_no_rows(tmp_path: Path, failure: str) -> None:
    import secrets

    path = tmp_path / "failure.sqlite3"
    migrate(path)
    terminal = Terminal(path)
    secret = secrets.token_urlsafe(24)
    try:
        terminal.expect("Пароль: ")
        if failure == "eof":
            os.write(terminal.master, b"\x04")
        elif failure == "cancel":
            terminal.process.send_signal(signal.SIGINT)
        else:
            terminal.send(secret if failure == "mismatch" else "short")
            terminal.expect("Повторите пароль: ")
            terminal.send(secret + "x" if failure == "mismatch" else "short")
        assert terminal.finish() == (130 if failure in {"eof", "cancel"} else 2)
        assert counts(path) == (0, 0)
        assert secret.encode() not in terminal.output
        assert b"Traceback" not in terminal.output
    finally:
        terminal.close()


def test_non_tty_refuses_without_fallback(tmp_path: Path) -> None:
    path = tmp_path / "nontty.sqlite3"
    migrate(path)
    env = os.environ.copy()
    env["LEXICONA_DATABASE_URL"] = f"sqlite+aiosqlite:///{path}"
    process = subprocess.run(
        [
            sys.executable,
            "-m",
            "lexicona.operations.admin",
            "bootstrap",
            "--login",
            "admin",
            "--display-name",
            "Имя",
        ],
        input="",
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert process.returncode == 2
    assert process.stdout == ""
    assert process.stderr.strip() == "Проверьте введённые данные."
    assert counts(path) == (0, 0)
