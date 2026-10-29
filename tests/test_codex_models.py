import importlib.util
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("codex_models", ROOT / "scripts/codex_models.py")
models = importlib.util.module_from_spec(spec)
spec.loader.exec_module(models)


def entry(name, hidden=False, high=True):
    return {
        "model": name,
        "hidden": hidden,
        "supportedReasoningEfforts": [{"reasoningEffort": "high" if high else "low"}],
    }


class ModelTests(unittest.TestCase):
    def test_selection(self):
        chosen = models.select_models(
            [
                entry("gpt-6.9-sol"),
                entry("gpt-6.10-sol"),
                entry("gpt-7-sol", hidden=True),
                entry("gpt-8-sol", high=False),
                entry("gpt-9-sol-preview"),
                entry("gpt-7-terra"),
                entry("gpt-6.20-terra"),
            ]
        )
        self.assertEqual(chosen, {"sol": "gpt-6.10-sol", "terra": "gpt-7-terra"})

    def make_roles(self, directory):
        for role, family in models.ROLES.items():
            (directory / f"{role}.toml").write_text(
                f'model = "gpt-6.1-{family}" # keep\nmodel_reasoning_effort = "high"\n'
                'developer_instructions = """\nmodel = \'leave me\'\n"""\n',
                encoding="utf-8",
            )

    def test_preserves_fields_and_does_not_downgrade(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.make_roles(directory)
            updates = models.plan_updates(
                directory, {"sol": "gpt-6.10-sol", "terra": "gpt-6-terra"}
            )
            self.assertEqual(len(updates), 2)
            models.apply_updates(updates)
            self.assertIn(
                'model = "gpt-6.10-sol" # keep', (directory / "architect.toml").read_text()
            )
            self.assertIn("model = 'leave me'", (directory / "architect.toml").read_text())
            self.assertIn('model = "gpt-6.1-terra"', (directory / "backend-agent.toml").read_text())
            self.assertEqual(
                models.plan_updates(directory, {"sol": "gpt-6.10-sol", "terra": "gpt-6-terra"}), []
            )

    def test_corruption_does_not_write_anything(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.make_roles(directory)
            (directory / "tests-agent.toml").write_text("broken = [")
            before = {p: p.read_bytes() for p in directory.iterdir()}
            with self.assertRaises(ValueError):
                models.plan_updates(directory, {"sol": "gpt-7-sol", "terra": "gpt-7-terra"})
            self.assertEqual(before, {p: p.read_bytes() for p in directory.iterdir()})

    def test_offline_leaves_files_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / ".codex/agents"
            directory.mkdir(parents=True)
            self.make_roles(directory)
            before = {p: p.read_bytes() for p in directory.iterdir()}
            with (
                patch.object(models, "ROOT", Path(tmp)),
                patch.object(models, "catalog", side_effect=TimeoutError("offline")),
            ):
                models.main()
            self.assertEqual(before, {p: p.read_bytes() for p in directory.iterdir()})

    def test_wrapper_forwards_arguments_offline_from_another_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "codex"
            fake.write_text(
                "#!/usr/bin/env python3\nimport json, os, sys\n"
                'if sys.argv[1:2] == ["app-server"]: sys.exit(1)\n'
                'open(os.environ["CAPTURE"], "w").write(json.dumps(sys.argv[1:]))\n'
            )
            fake.chmod(0o755)
            capture = Path(tmp) / "args"
            env = dict(os.environ, PATH=f"{tmp}:{os.environ['PATH']}", CAPTURE=str(capture))
            result = subprocess.run(  # noqa: S603
                [str(ROOT / "scripts/codex"), "one two", "--flag"],
                cwd=tmp,
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            import json

            self.assertEqual(
                json.loads(capture.read_text()), ["-C", str(ROOT), "one two", "--flag"]
            )
            self.assertIn("Warning", result.stderr)

    def test_catalog_paginates(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "codex"
            fake.write_text("""#!/usr/bin/env python3
import json, sys
expected = ["initialize", "initialized", "model/list", "model/list"]
for line in sys.stdin:
    msg = json.loads(line)
    if not expected or msg.get("method") != expected.pop(0):
        sys.exit(2)
    if msg["method"] == "initialize":
        print(json.dumps({"method": "notice", "params": {}}), flush=True)
        print(json.dumps({"id": msg["id"], "result": {}}), flush=True)
    elif msg["method"] == "initialized":
        if msg.get("params") != {} or "id" in msg:
            sys.exit(3)
    elif msg["method"] == "model/list":
        cursor = msg["params"].get("cursor")
        result = {"data": [{"model": "second" if cursor else "first"}],
                  "nextCursor": None if cursor else "next"}
        print(json.dumps({"id": msg["id"], "result": result}), flush=True)
""")
            fake.chmod(0o755)
            with patch.dict(os.environ, {"PATH": f"{tmp}:{os.environ['PATH']}"}):
                self.assertEqual(
                    [x["model"] for x in models.catalog(timeout=3)], ["first", "second"]
                )

    def test_catalog_timeout_terminates_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "codex"
            pid_file = Path(tmp) / "pid"
            fake.write_text(
                "#!/usr/bin/env python3\nimport os, sys\n"
                'open(os.environ["PID_FILE"], "w").write(str(os.getpid()))\n'
                "for line in sys.stdin: pass\n"
            )
            fake.chmod(0o755)
            env = {"PATH": f"{tmp}:{os.environ['PATH']}", "PID_FILE": str(pid_file)}
            start = time.monotonic()
            with patch.dict(os.environ, env), self.assertRaises(TimeoutError):
                models.catalog(timeout=0.3)
            self.assertLess(time.monotonic() - start, 3)
            pid = int(pid_file.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)


if __name__ == "__main__":
    unittest.main()
