"""Require every production Python file to have complete line/branch coverage."""

import argparse
from collections.abc import Sequence
from pathlib import Path

from pydantic import BaseModel


class Summary(BaseModel):
    num_statements: int


class FileCoverage(BaseModel):
    executed_lines: list[int]
    missing_lines: list[int]
    missing_branches: list[tuple[int, int]]
    excluded_lines: list[int]
    summary: Summary


class Metadata(BaseModel):
    branch_coverage: bool


class CoverageReport(BaseModel):
    meta: Metadata
    files: dict[str, FileCoverage]


class Arguments(argparse.Namespace):
    report: Path
    roots: list[Path]


def main(argv: Sequence[str] | None = None) -> int:
    """Check coverage JSON against independently enumerated production roots."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("roots", type=Path, nargs="+")
    args = parser.parse_args(argv, namespace=Arguments())
    report = CoverageReport.model_validate_json(args.report.read_text(encoding="utf-8"))
    issues: list[str] = []
    if not report.meta.branch_coverage:
        issues.append("branch measurement required")
    for root in args.roots:
        if not root.is_dir():
            issues.append(f"missing source root: {root}")
    sources = {p.resolve() for root in args.roots for p in root.rglob("*.py")}
    if not sources:
        issues.append("no production source")
    measured = {Path(name).resolve(): data for name, data in report.files.items()}
    for source in sorted(sources):
        data = measured.get(source)
        if data is None:
            issues.append(f"unimported source: {source}")
            continue
        if data.summary.num_statements and not data.executed_lines:
            issues.append(f"unimported source: {source}")
        if data.missing_lines:
            issues.append(f"missing lines: {source}: {data.missing_lines}")
        if data.missing_branches:
            issues.append(f"missing branches: {source}: {data.missing_branches}")
        if data.excluded_lines:
            issues.append(f"excluded lines: {source}: {data.excluded_lines}")
    if issues:
        print("\n".join(issues))
        return 1
    print(f"{len(sources)} source files: 100% lines and branches")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
