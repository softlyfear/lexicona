"""Regression tests for patch payloads and the formatter's filesystem boundary."""

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / ".codex/hooks/format.py"
spec = importlib.util.spec_from_file_location("format_hook", MODULE)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class FormatterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        (self.root / "backend").mkdir(parents=True)
        (self.root / "backend/a.py").touch()
        (self.root / "backend/b.py").touch()
        self.override = patch.object(hook, "ROOT", self.root)
        self.override.start()
        self.addCleanup(self.override.stop)

    def paths(self, command, cwd=None):
        return hook.edited_paths({"cwd": str(cwd or self.root), "tool_input": {"command": command}})

    def test_patch_multiple_files_and_move(self):
        result = self.paths(
            "*** Update File: backend/a.py\n*** Move to: backend/b.py\n"
            "*** Add File: backend/b.py\n*** Delete File: backend/deleted.py"
        )
        self.assertEqual(result, [self.root / "backend/a.py", self.root / "backend/b.py"])

    def test_subdirectory_and_legacy_event(self):
        self.assertEqual(
            self.paths("*** Update File: a.py", self.root / "backend"), [self.root / "backend/a.py"]
        )
        self.assertEqual(
            hook.edited_paths({"cwd": str(self.root), "tool_input": {"file_path": "backend/a.py"}}),
            [self.root / "backend/a.py"],
        )

    def test_outside_symlink_and_generated_files_are_ignored(self):
        outside = Path(self.temp.name) / "outside.py"
        outside.touch()
        (self.root / "backend/link.py").symlink_to(outside)
        (self.root / "frontend/node_modules").mkdir(parents=True)
        (self.root / "frontend/node_modules/a.ts").touch()
        self.assertEqual(
            self.paths(
                "*** Update File: ../outside.py\n"
                "*** Update File: backend/link.py\n"
                "*** Update File: frontend/node_modules/a.ts"
            ),
            [],
        )

    def test_shell_text_does_not_become_command(self):
        self.assertEqual(self.paths("rm -rf backend"), [])
        cwd, tasks = hook.commands(self.root / "backend/a.py")
        self.assertEqual(cwd, self.root / "backend")
        self.assertEqual(tasks[0][-1], str(self.root / "backend/a.py"))
        self.assertIn("--locked", tasks[0])

    def test_unknown_payload_is_ignored(self):
        self.assertEqual(hook.edited_paths({"tool_input": None}), [])


if __name__ == "__main__":
    unittest.main()
