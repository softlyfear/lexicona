import ast
from pathlib import Path

ROOT = Path(__file__).parents[1] / "src" / "lexicona"
FORBIDDEN = {
    "domain": (
        "fastapi",
        "starlette",
        "sqlalchemy",
        "pydantic",
        "urllib",
        "piper",
        "lexicona.infrastructure",
        "lexicona.interfaces",
        "lexicona.application",
    ),
    "application": ("fastapi", "starlette", "lexicona.interfaces"),
    "infrastructure": ("fastapi", "starlette", "lexicona.interfaces", "lexicona.application"),
}


def imported_modules(path: Path) -> set[str]:
    found: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.add(node.module)
    return found


def test_layer_imports_point_inward() -> None:
    for layer, banned in FORBIDDEN.items():
        for path in (ROOT / layer).rglob("*.py"):
            for name in imported_modules(path):
                assert not any(
                    name == prefix or name.startswith(f"{prefix}.") for prefix in banned
                ), (
                    path,
                    name,
                )
