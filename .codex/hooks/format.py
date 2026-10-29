#!/usr/bin/env python3
"""Format explicit edited paths from Codex/Claude events; never execute shell input."""

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def edited_paths(event):
    """Support Codex patch commands and legacy file_path payloads."""
    data = event.get("tool_input", {})
    if isinstance(data, str):
        data = {"command": data}
    if not isinstance(data, dict):
        return []
    names = []
    if isinstance(data.get("file_path"), str):
        names.append(data["file_path"])
    patch = data.get("command", data.get("input", ""))
    if isinstance(patch, str):
        for line in patch.splitlines():
            for prefix in ("*** Add File: ", "*** Update File: ", "*** Move to: "):
                if line.startswith(prefix):
                    names.append(line[len(prefix) :])
    cwd = Path(event.get("cwd") or ROOT)
    result = set()
    for name in names:
        path = (cwd / name).resolve()
        if path.is_relative_to(ROOT) and path.is_file():
            relative = path.relative_to(ROOT)
            if not any(
                part.startswith(".") or part in {"node_modules", "dist", "coverage"}
                for part in relative.parts
            ):
                result.add(path)
    return sorted(result)


def commands(path):
    relative = path.relative_to(ROOT)
    if relative.parts[0] == "backend" and path.suffix == ".py":
        return ROOT / "backend", [
            ["uv", "run", "--locked", "--no-sync", "ruff", "format", str(path)],
        ]
    if relative.parts[0] == "frontend" and path.suffix in {".ts", ".tsx", ".css", ".json"}:
        return ROOT / "frontend", [
            ["npm", "exec", "--no", "--", "prettier", "--write", "--log-level", "warn", str(path)],
        ]
    return ROOT, []


def main():
    try:
        event = json.load(sys.stdin)
        if not isinstance(event, dict):
            return
        errors = []
        deadline = time.monotonic() + 25
        for path in edited_paths(event):
            if time.monotonic() >= deadline:
                errors.append("Hook time budget reached; remaining files skipped")
                break
            cwd, tasks = commands(path)
            for command in tasks:
                try:
                    # Commands are fixed argv lists; paths are confined to ROOT, no shell.
                    done = subprocess.run(  # noqa: S603
                        command,
                        cwd=cwd,
                        capture_output=True,
                        text=True,
                        timeout=max(0.1, min(20, deadline - time.monotonic())),
                    )
                    if done.returncode:
                        errors.append(
                            f"{path.relative_to(ROOT)}: formatter exited {done.returncode}"
                        )
                except (OSError, subprocess.TimeoutExpired) as exc:
                    errors.append(f"{path.relative_to(ROOT)}: {exc}")
        if errors:
            print(
                json.dumps(
                    {
                        "hookSpecificOutput": {
                            "hookEventName": "PostToolUse",
                            "additionalContext": "Run make fmt and make check. "
                            + "; ".join(errors),
                        }
                    }
                )
            )
    except (ValueError, OSError) as exc:
        print(f"format hook: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
