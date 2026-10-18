"""Require every production Python file to have complete line/branch coverage."""

import argparse
import re
import tokenize
from collections.abc import Sequence
from pathlib import Path

from coverage import Coverage
from pydantic import BaseModel, Field


class Summary(BaseModel):
    num_statements: int


class FileCoverage(BaseModel):
    executed_lines: list[int]
    executed_branches: list[tuple[int, int]] = Field(default_factory=list)
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
    # The approved exemption registry is empty. Reparse source without report
    # regexes (including defaults); never trust suppressed JSON missing lists.
    # Only real reported arcs are evidence: line hits cannot invent taken exits.
    unsuppressed = Coverage(branch=True, config_file=False, data_file=None)
    unsuppressed.clear_exclude()
    unsuppressed.clear_exclude("partial")
    execution = unsuppressed.get_data()
    try:
        for source in sorted(sources):
            # Tokenization distinguishes real comments from quoted examples,
            # including multiline strings and quote characters inside comments.
            with tokenize.open(source) as source_file:
                for token in tokenize.generate_tokens(source_file.readline):
                    if token.type == tokenize.COMMENT and re.search(
                        r"#\s*pragma[:\s]?\s*no\s*(?:cover|branch)",
                        token.string,
                        re.IGNORECASE,
                    ):
                        issues.append(
                            f"unapproved coverage pragma: {source}:{token.start[0]}"
                        )
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
            execution.add_arcs({str(source): data.executed_branches})
            _, statements, _, _, _ = unsuppressed.analysis2(str(source))
            missing = sorted(set(statements) - set(data.executed_lines))
            if missing:
                issues.append(f"unsuppressed missing lines: {source}: {missing}")
            incomplete = {
                line: counts
                for line, counts in unsuppressed.branch_stats(str(source)).items()
                if counts[0] != counts[1]
            }
            if incomplete:
                issues.append(f"unsuppressed missing branches: {source}: {incomplete}")
    finally:
        execution.close(force=True)
    if issues:
        print("\n".join(issues))
        return 1
    print(f"{len(sources)} source files: 100% lines and branches")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
