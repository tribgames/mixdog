import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness.prebake_cache import ARTIFACTS, CACHE_TARGET, cache_identity, prepare


class PrebakeCacheTests(unittest.TestCase):
    def test_archive_changes_select_a_new_read_only_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ARTIFACTS:
                (root / name).write_bytes(name.encode())
            (root / "prebake.json").write_text(json.dumps({"image": "debian:bookworm-slim"}))
            original = cache_identity(root)
            output = root / "compose.json"
            with mock.patch("harness.prebake_cache.subprocess.run") as run:
                volume = prepare(root, output)
            compose = json.loads(output.read_text())
            mount = compose["services"]["main"]["volumes"][0]
            self.assertTrue(mount["read_only"])
            self.assertEqual(mount["target"], CACHE_TARGET)
            self.assertEqual(compose["volumes"][mount["source"]]["name"], volume)
            self.assertTrue(compose["volumes"][mount["source"]]["external"])
            self.assertIn("--network", run.call_args.args[0])
            (root / ARTIFACTS[0]).write_bytes(b"new archive")
            self.assertNotEqual(cache_identity(root), original)


if __name__ == "__main__":
    unittest.main()
