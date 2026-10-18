"""The gate must distrust rounded totals and inventory source independently."""

import json
import runpy
import subprocess
import sys
from pathlib import Path

import pytest


def real_coverage_report(
    tmp_path: Path, program: str, option: str = "", pattern: str = ""
) -> tuple[Path, Path]:
    """Generate actual coverage JSON in a separate interpreter, without mocks."""
    source = tmp_path / "source"
    source.mkdir()
    module = source / "probe.py"
    module.write_text(program, encoding="utf-8")
    report = tmp_path / "coverage.json"
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import runpy, sys\nfrom coverage import Coverage\n"
            "c = Coverage(branch=True, config_file=False, data_file=None, "
            "source=[sys.argv[1]])\n"
            "if sys.argv[4]:\n    c.set_option(sys.argv[4], [sys.argv[5]])\n"
            "c.start()\nrunpy.run_path(sys.argv[2])\nc.stop()\n"
            "c.json_report(outfile=sys.argv[3])",
            str(source),
            str(module),
            str(report),
            option,
            pattern,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    return report, source


@pytest.mark.parametrize(
    ("suffix", "option", "pattern"),
    [
        ("", "", ""),
        ("  # pragma: no branch", "", ""),
        ("  # PRAGMA: NO BRANCH", "", ""),
        ("  # pragma: no cover", "", ""),
        ("", "report:partial_branches", "if flag:"),
        ("", "report:partial_branches", r"if flag:\n\s+result"),
        ("", "report:exclude_lines", "if flag:"),
    ],
)
def test_gate_rechecks_real_suppressed_coverage(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    suffix: str,
    option: str,
    pattern: str,
) -> None:
    from tools.coverage_gate import main

    report, source = real_coverage_report(
        tmp_path,
        "def f(flag):\n    result = 0\n    if flag:"
        + suffix
        + "\n        result = 1\n    return result\nf(True)\n",
        option,
        pattern,
    )
    data = next(iter(json.loads(report.read_text())["files"].values()))
    if "branch" in suffix.lower() or option == "report:partial_branches":
        # The reviewer exploit: the real JSON conceals the unexecuted arc.
        assert data["missing_branches"] == []
        assert data["excluded_lines"] == []
        assert data["missing_lines"] == []
    assert main([str(report), str(source)]) == 1
    assert "source files: 100%" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "pragma",
    ["# pragma: no branch", "# PRAGMA: NO COVER", "# pragma: no branch # 'quoted'"],
)
def test_gate_rejects_exercised_unapproved_comment_pragmas(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], pragma: str
) -> None:
    from tools.coverage_gate import main

    report, source = real_coverage_report(
        tmp_path,
        "def f(flag):\n"
        "    result = 0\n"
        f"    if flag:  {pragma}\n"
        "        result = 1\n"
        "    return result\n"
        "f(True)\nf(False)\n",
        "report:exclude_lines",
        "(?!)",
    )
    assert main([str(report), str(source)]) == 1
    assert "unapproved coverage pragma" in capsys.readouterr().out


def test_gate_accepts_real_covered_pragma_strings(tmp_path: Path) -> None:
    from tools.coverage_gate import main

    report, source = real_coverage_report(
        tmp_path,
        "def f(flag):\n"
        "    text = '''# pragma: no cover\n# pragma: no branch'''\n"
        "    if flag: text = '# pragma: no branch'\n"
        "    # An ordinary comment is not an exemption.\n"
        "    return text\n"
        "f(True)\nf(False)\n",
        "report:exclude_lines",
        "(?!)",
    )
    assert main([str(report), str(source)]) == 0


def test_gate_accepts_fully_measured_source(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    module = source / "example.py"
    module.write_text("answer = 42\n", encoding="utf-8")
    report = tmp_path / "coverage.json"
    report.write_text(
        json.dumps(
            {
                "meta": {"branch_coverage": True},
                "files": {
                    str(module): {
                        "executed_lines": [1],
                        "missing_lines": [],
                        "missing_branches": [],
                        "excluded_lines": [],
                        "summary": {"num_statements": 1},
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [sys.executable, "-m", "tools.coverage_gate", str(report), str(source)],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "1 source files: 100% lines and branches" in result.stdout


@pytest.mark.parametrize(
    ("fault", "diagnostic"),
    [
        ("lines", "missing lines"),
        ("branches", "missing branches"),
        ("absent", "unimported source"),
        ("unexecuted", "unimported source"),
        ("excluded", "excluded lines"),
        ("line_only", "branch measurement required"),
        ("empty", "no production source"),
        ("missing_root", "missing source root"),
    ],
)
def test_gate_rejects_incomplete_measurement(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], fault: str, diagnostic: str
) -> None:
    from tools.coverage_gate import main

    source = tmp_path / "source"
    source.mkdir()
    module = source / "example.py"
    module.write_text("answer = 42\n", encoding="utf-8")
    file_data: dict[str, object] = {
        "executed_lines": [1],
        "missing_lines": [2] if fault == "lines" else [],
        "missing_branches": [[1, 2]] if fault == "branches" else [],
        "excluded_lines": [3] if fault == "excluded" else [],
        "summary": {"num_statements": 1},
    }
    if fault == "unexecuted":
        file_data["executed_lines"] = []
        file_data["missing_lines"] = [1]
    if fault == "empty":
        module.unlink()
    if fault == "missing_root":
        source = tmp_path / "absent"
    report = tmp_path / "coverage.json"
    report.write_text(
        json.dumps(
            {
                "meta": {"branch_coverage": fault != "line_only"},
                "files": {} if fault == "absent" else {str(module): file_data},
            }
        ),
        encoding="utf-8",
    )
    assert main([str(report), str(source)]) == 1
    assert diagnostic in capsys.readouterr().out


def test_gate_cli_entrypoint(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / "empty.py"
    source.write_text('"""An empty module has no executable statements."""\n')
    report = tmp_path / "coverage.json"
    report.write_text(
        json.dumps(
            {
                "meta": {"branch_coverage": True},
                "files": {
                    str(source): {
                        "executed_lines": [],
                        "missing_lines": [],
                        "missing_branches": [],
                        "excluded_lines": [],
                        "summary": {"num_statements": 0},
                    }
                },
            }
        )
    )
    monkeypatch.setattr(sys, "argv", ["coverage_gate", str(report), str(tmp_path)])
    with pytest.raises(SystemExit) as exc:
        runpy.run_path("tools/coverage_gate.py", run_name="__main__")
    assert exc.value.code == 0
    assert "1 source files" in capsys.readouterr().out
