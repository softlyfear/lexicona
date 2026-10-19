"""Real instrumentation and Git inventory, not handwritten coverage evidence."""

import json
import subprocess
from pathlib import Path

import pytest
from test_coverage_gate import real_coverage_report

from tools.coverage_gate import main


def git(directory: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(directory), *args], capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def test_manifest_records_untracked_rename_and_type_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report, source = real_coverage_report(tmp_path, "answer = 42\n")
    git(tmp_path, "init")
    git(tmp_path, "add", "source")
    git(
        tmp_path,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "baseline",
    )
    baseline = git(tmp_path, "rev-parse", "HEAD")
    git(tmp_path, "mv", "source/probe.py", "source/renamed.py")
    (source / "untracked.py").write_text("new_answer = 7\n")
    (source / "types.pyi").write_text("type Identifier = str\n")
    monkeypatch.chdir(tmp_path)
    manifest = tmp_path / "manifest.json"
    assert (
        main(
            [
                str(report),
                str(source),
                "--baseline",
                baseline,
                "--manifest",
                str(manifest),
            ]
        )
        == 1
    )
    data = json.loads(manifest.read_text())
    assert data["baseline"] == baseline
    assert data["diff_name_status"] == ["R100", "source/probe.py", "source/renamed.py"]
    assert set(data["untracked"]) == {"source/untracked.py", "source/types.pyi"}
    entries = {Path(entry["path"]).name: entry for entry in data["sources"]}
    assert entries["renamed.py"]["status"] == "unmeasured"
    assert entries["untracked.py"]["status"] == "unmeasured"
    assert entries["types.pyi"]["status"] == "not_applicable"
    assert entries["types.pyi"]["reason"] == "typing stub; no runtime executable units"
    assert len(entries["renamed.py"]["sha256"]) == 64
    assert data["passed"] is False


def test_manifest_identifies_empty_and_branchless_sources(tmp_path: Path) -> None:
    report, source = real_coverage_report(tmp_path, "answer = 42\n")
    empty = source / "empty.py"
    empty.write_text('"""No executable units."""\n')
    manifest = tmp_path / "manifest.json"
    assert main([str(report), str(source), "--manifest", str(manifest)]) == 0
    data = json.loads(manifest.read_text())
    entries = {Path(entry["path"]).name: entry for entry in data["sources"]}
    assert entries["empty.py"]["status"] == "not_applicable"
    assert entries["empty.py"]["reason"] == "no executable units"
    assert entries["probe.py"]["branchless"] is True
    assert data["passed"] is True
