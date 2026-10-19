"""Require every production Python file to have complete line/branch coverage."""

import argparse
import hashlib
import json
import re
import subprocess
import tokenize
from collections.abc import Sequence
from pathlib import Path
from typing import Literal

from coverage import Coverage
from pydantic import BaseModel, ConfigDict, ValidationError


class Summary(BaseModel):
    num_statements: int


class FileCoverage(BaseModel):
    executed_lines: list[int]
    executed_branches: list[tuple[int, int]]
    missing_lines: list[int]
    missing_branches: list[tuple[int, int]]
    excluded_lines: list[int]
    summary: Summary


class Metadata(BaseModel):
    format: Literal[3]
    version: Literal["7.16.2"]
    branch_coverage: bool


class CoverageReport(BaseModel):
    model_config = ConfigDict(strict=True)
    meta: Metadata
    files: dict[str, FileCoverage]


class Arguments(argparse.Namespace):
    report: Path
    roots: list[Path]
    manifest: Path | None
    baseline: str | None


def provenance(baseline: str, roots: list[Path]) -> dict[str, object]:
    """Record Git rename mapping and new files; never select coverage by diff."""

    def git(*arguments: str) -> str:
        return subprocess.run(
            ["git", *arguments], check=True, capture_output=True, text=True
        ).stdout

    revision = git(
        "rev-parse", "--verify", "--end-of-options", baseline + "^{commit}"
    ).strip()
    paths = [str(root) for root in roots]
    return {
        "baseline": revision,
        "diff_name_status": git(
            "diff", "--relative", "--name-status", "-z", "-M", revision, "--", *paths
        ).split("\0")[:-1],
        "untracked": git(
            "ls-files", "--others", "--exclude-standard", "-z", "--", *paths
        ).split("\0")[:-1],
    }


def main(argv: Sequence[str] | None = None) -> int:
    """Check coverage JSON against independently enumerated production roots."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("roots", type=Path, nargs="+")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--baseline")
    args = parser.parse_args(argv, namespace=Arguments())
    try:
        report = CoverageReport.model_validate_json(
            args.report.read_text(encoding="utf-8"), strict=True
        )
    except (OSError, ValidationError) as error:
        print(f"invalid coverage report: {error}")
        return 1
    issues: list[str] = []
    if not report.meta.branch_coverage:
        issues.append("branch measurement required")
    for root in args.roots:
        if not root.is_dir():
            issues.append(f"missing source root: {root}")
    sources = {p.resolve() for root in args.roots for p in root.rglob("*.py")}
    stubs = {p.resolve() for root in args.roots for p in root.rglob("*.pyi")}
    inventory: list[dict[str, object]] = []
    if not sources:
        issues.append("no production source")
    measured = {Path(name).resolve(): data for name, data in report.files.items()}
    # No report exclusions, including tool defaults. Only measured arcs are
    # evidence; executed lines cannot synthesize branch outcomes.
    unsuppressed = Coverage(branch=True, config_file=False, data_file=None)
    unsuppressed.clear_exclude()
    unsuppressed.clear_exclude("partial")
    execution = unsuppressed.get_data()
    try:
        for source in sorted(sources | stubs):
            entry: dict[str, object] = {
                "path": str(source),
                "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            }
            inventory.append(entry)
            if source.suffix == ".pyi":
                entry.update(
                    status="not_applicable",
                    reason="typing stub; no runtime executable units",
                )
                continue
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
            _, statements, _, _, _ = unsuppressed.analysis2(str(source))
            if not statements:
                entry.update(status="not_applicable", reason="no executable units")
                continue
            if data is None:
                entry["status"] = "unmeasured"
                issues.append(f"unimported source: {source}")
                continue
            entry["status"] = "measured"
            if data.summary.num_statements and not data.executed_lines:
                issues.append(f"unimported source: {source}")
            if data.missing_lines:
                issues.append(f"missing lines: {source}: {data.missing_lines}")
            if data.missing_branches:
                issues.append(f"missing branches: {source}: {data.missing_branches}")
            if data.excluded_lines:
                issues.append(f"excluded lines: {source}: {data.excluded_lines}")
            execution.add_arcs({str(source): data.executed_branches})
            missing = sorted(set(statements) - set(data.executed_lines))
            if missing:
                issues.append(f"unsuppressed missing lines: {source}: {missing}")
            branches = unsuppressed.branch_stats(str(source))
            entry["branchless"] = not branches
            incomplete = {
                line: counts
                for line, counts in branches.items()
                if counts[0] != counts[1]
            }
            if incomplete:
                issues.append(f"unsuppressed missing branches: {source}: {incomplete}")
    finally:
        execution.close(force=True)
    if args.manifest is not None:
        manifest: dict[str, object] = {
            "sources": inventory,
            "report_sha256": hashlib.sha256(args.report.read_bytes()).hexdigest(),
            "coverage_version": report.meta.version,
            "passed": not issues,
        }
        if args.baseline is not None:
            manifest.update(provenance(args.baseline, args.roots))
        args.manifest.write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )
    if issues:
        print("\n".join(issues))
        return 1
    print(f"{len(sources)} source files: 100% lines and branches")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
