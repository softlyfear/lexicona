"""Export/check actual application OpenAPI without lifespan, DB or private state."""

import argparse
import json
from collections.abc import Sequence
from pathlib import Path

from lexicona.app import create_app

DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "openapi" / "auth-v1.json"


class Arguments(argparse.Namespace):
    check: bool
    output: Path


def render() -> str:
    """Build the real factory's schema without connecting or running hashing."""
    app = create_app(database_url="sqlite+aiosqlite:///schema-not-opened.sqlite3")
    return (
        json.dumps(app.openapi(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    )


def main(argv: Sequence[str] | None = None) -> int:
    """Export stable bytes, or fail closed if the checked-in artifact differs."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("output", type=Path, nargs="?", default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv, namespace=Arguments())
    content = render()
    try:
        if args.check:
            if args.output.read_text(encoding="utf-8") != content:
                print("OpenAPI drift: regenerate the implemented application schema.")
                return 1
        else:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(content, encoding="utf-8")
    except OSError:
        print("OpenAPI artifact could not be read or written.")
        return 1
    print("OpenAPI matches implemented routes." if args.check else "OpenAPI exported.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
