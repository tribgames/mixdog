import tempfile
import unittest
from pathlib import Path

from harness.provenance import harness_manifest


class HarnessProvenanceTests(unittest.TestCase):
    def test_tracks_code_changes_but_not_runtime_jobs_or_bytecode(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "harness").mkdir()
            (root / "run.ps1").write_text("launcher")
            (root / "presets.json").write_text("{}")
            source = root / "harness/agent.py"
            source.write_text("version = 1")
            original = harness_manifest(root)
            self.assertEqual(original, harness_manifest(root))
            (root / "jobs-result.json").write_text("{}")
            bytecode = root / "harness/__pycache__"
            bytecode.mkdir()
            (bytecode / "agent.pyc").write_bytes(b"cache")
            self.assertEqual(original, harness_manifest(root))
            source.write_text("version = 2")
            changed = harness_manifest(root)
            self.assertNotEqual(original["sha256"], changed["sha256"])
            self.assertEqual(len(changed["files"]), 3)
