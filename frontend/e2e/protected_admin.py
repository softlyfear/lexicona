"""Frontend-only real CLI harness. All secret input stays in pipes/hidden PTY memory."""

import json
import os
import select
import signal
import sqlite3
import subprocess
import sys
import termios
import time


def run():
    data = json.load(sys.stdin)
    password = data["password"]
    database = data["database"]
    fault = data.get("fault", False)
    master, slave = os.openpty()
    process = None
    output = b""
    noecho = 0
    outcome = False

    def read_until(text):
        nonlocal output
        deadline = time.monotonic() + 6
        while text.encode() not in output:
            if time.monotonic() >= deadline or len(output) > 65536:
                raise RuntimeError()
            if select.select([master], [], [], 0.025)[0]:
                output += os.read(master, 65536)

    def send(child):
        nonlocal noecho
        if termios.tcgetattr(slave)[3] & termios.ECHO:
            raise RuntimeError()
        for name in ["cmdline", "environ"]:
            with open(f"/proc/{child.pid}/{name}", "rb") as source:
                if password.encode() in source.read():
                    raise RuntimeError()
        noecho += 1
        os.write(master, password.encode() + b"\n")

    try:
        env = os.environ.copy()
        env["LEXICONA_DATABASE_URL"] = "sqlite+aiosqlite:///" + database
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "lexicona.operations.admin",
                "bootstrap",
                "--login",
                data["login"],
                "--display-name",
                "CLI administrator",
            ],
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env=env,
        )
        read_until("Пароль: ")
        if fault:
            raise InterruptedError()
        send(process)
        read_until("Повторите пароль: ")
        send(process)
        if process.wait(timeout=12) != 0:
            raise RuntimeError()
        while select.select([master], [], [], 0)[0]:
            output += os.read(master, 65536)
        outcome = "Первый администратор создан.".encode() in output
    except InterruptedError:
        if not fault:
            raise
    finally:
        if process is not None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        os.close(master)
        os.close(slave)
    clean = (
        password.encode() not in output
        and b"$argon2" not in output
        and b"Traceback" not in output
    )
    with sqlite3.connect(database) as db:
        rows = db.execute("SELECT count(*) FROM users").fetchone()[0]
        settings = db.execute("SELECT count(*) FROM user_settings").fetchone()[0]
        wal = db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        admin = fault or db.execute("SELECT role FROM users").fetchone()[0] == "admin"
    if (
        not clean
        or not wal
        or not admin
        or (rows, settings) != ((0, 0) if fault else (1, 1))
    ):
        raise RuntimeError()
    if not fault and (not outcome or noecho != 2):
        raise RuntimeError()
    return {
        "success": outcome,
        "fault_cleaned": fault,
        "noecho_checks": noecho,
        "output_redacted": clean,
        "wal": wal,
        "users": rows,
        "settings": settings,
    }


def stop(signum, frame):
    raise KeyboardInterrupt()


signal.signal(signal.SIGTERM, stop)
try:
    print(json.dumps(run()))
except (
    KeyboardInterrupt,
    EOFError,
    OSError,
    RuntimeError,
    ValueError,
    subprocess.SubprocessError,
    KeyError,
    TypeError,
):
    print("Protected CLI harness failed (details redacted)", file=sys.stderr)
    sys.exit(1)
