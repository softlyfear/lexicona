"""Regression tests for Kimi tool payloads and the formatter filesystem boundary."""

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / ".kimi-code/hooks/format.py"
spec = importlib.util.spec_from_file_location("kimi_format_hook", MODULE)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class KimiFormatterTests(unittest.TestCase):
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

    def test_edit_write_and_legacy_paths(self):
        event = {"cwd": str(self.root), "tool_input": {"path": "backend/a.py"}}
        self.assertEqual(hook.edited_paths(event), [self.root / "backend/a.py"])
        event["tool_input"] = {"file_path": "backend/b.py"}
        self.assertEqual(hook.edited_paths(event), [self.root / "backend/b.py"])

    def test_patch_multiple_files_and_move(self):
        result = hook.edited_paths(
            {
                "cwd": str(self.root),
                "tool_input": {
                    "command": "*** Update File: backend/a.py\n*** Move to: backend/b.py\n"
                    "*** Add File: backend/b.py\n*** Delete File: backend/deleted.py"
                },
            }
        )
        self.assertEqual(result, [self.root / "backend/a.py", self.root / "backend/b.py"])

    def test_outside_symlink_and_generated_files_are_ignored(self):
        outside = Path(self.temp.name) / "outside.py"
        outside.touch()
        (self.root / "backend/link.py").symlink_to(outside)
        (self.root / "frontend/node_modules").mkdir(parents=True)
        (self.root / "frontend/node_modules/a.ts").touch()
        event = {
            "cwd": str(self.root),
            "tool_input": {
                "command": "*** Update File: ../outside.py\n"
                "*** Update File: backend/link.py\n"
                "*** Update File: frontend/node_modules/a.ts"
            },
        }
        self.assertEqual(hook.edited_paths(event), [])

    def test_shell_text_does_not_become_command(self):
        event = {"cwd": str(self.root), "tool_input": {"command": "rm -rf backend"}}
        self.assertEqual(hook.edited_paths(event), [])
        cwd, tasks = hook.commands(self.root / "backend/a.py")
        self.assertEqual(cwd, self.root / "backend")
        self.assertEqual(tasks[0][-1], str(self.root / "backend/a.py"))
        self.assertIn("--locked", tasks[0])

    def test_unknown_payload_is_ignored(self):
        self.assertEqual(hook.edited_paths({"tool_input": None}), [])


if __name__ == "__main__":
    unittest.main()
