"""Instrumented negative probes including unchanged-file baseline regression."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from tools.coverage_gate import main


def instrument(directory: Path, runner: str) -> Path:
    """Measure real fixture source with the pinned project interpreter."""
    driver = directory / "runner.py"
    driver.write_text(runner)
    report = directory / "coverage.json"
    process = subprocess.run(
        [
            sys.executable,
            "-c",
            "import runpy,sys\nfrom coverage import Coverage\n"
            "c=Coverage(branch=True,config_file=False,data_file=None,source=[sys.argv[1]])\n"
            "c.start()\nrunpy.run_path(sys.argv[2])\nc.stop()\nc.json_report(outfile=sys.argv[3])",
            str(directory / "source"),
            str(driver),
            str(report),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    return report


def test_real_missing_line_and_unchanged_baseline_regression(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    module = source / "probe.py"
    module.write_text("def f(flag):\n    if flag:\n        return 1\n    return 2\n")
    invocation = f"import runpy\nm=runpy.run_path({str(module)!r})\n"
    report = instrument(tmp_path, invocation + "m['f'](True)\nm['f'](False)\n")
    assert main([str(report), str(source)]) == 0
    original = module.read_bytes()
    report = instrument(tmp_path, invocation + "m['f'](True)\n")
    assert module.read_bytes() == original  # Only the tests changed, not production.
    assert main([str(report), str(source)]) == 1


@pytest.mark.parametrize(
    "kind", ["branch", "unimported", "default_ignore", "partial_default"]
)
def test_instrumented_negative_probes(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], kind: str
) -> None:
    source = tmp_path / "source"
    source.mkdir()
    module = source / "probe.py"
    programs = {
        "branch": (
            "def f(flag):\n    result=0\n    if flag:\n"
            "        result=1\n    return result\nf(True)\n"
        ),
        "unimported": "def f():\n    return 1\n",
        "default_ignore": (
            "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n"
            "    hidden=1\nanswer=42\n"
        ),
        "partial_default": (
            "def f(flag):\n    result=0\n    if flag:  # pragma: no branch\n"
            "        result=1\n    return result\nf(True)\n"
        ),
    }
    module.write_text(programs[kind])
    runner = (
        "answer=42\n"
        if kind == "unimported"
        else f"import runpy\nrunpy.run_path({str(module)!r})\n"
    )
    report = instrument(tmp_path, runner)
    data = next(iter(json.loads(report.read_text())["files"].values()))
    if kind in {"branch", "partial_default"}:
        assert data["missing_lines"] == [], "Every executable line really ran"
    if kind == "partial_default":
        assert data["missing_branches"] == [], "Default pragma concealed a real exit"
    if kind == "default_ignore":
        assert data["missing_lines"] == []
        assert data["excluded_lines"]
    assert main([str(report), str(source)]) == 1
    assert "source files: 100%" not in capsys.readouterr().out
