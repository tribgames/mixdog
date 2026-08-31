"""Bundle identity: what a published run can prove it executed."""

from __future__ import annotations

import hashlib
import sys
import tempfile
import unittest
from pathlib import Path


BENCH_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BENCH_ROOT))

from harness.src_overlay import (  # noqa: E402
    build_src_snapshot,
    bundle_manifest,
)


def _sample_tree(root: Path) -> tuple[Path, Path]:
    source = root / "src"
    (source / "runtime").mkdir(parents=True)
    (source / "cli.mjs").write_text("console.log('cli');\n", encoding="utf-8")
    (source / "runtime" / "agent.mjs").write_text(
        "export const agent = 1;\n", encoding="utf-8"
    )
    spawn = root / "runtime-build" / "mixdog-spawn-linux-x64"
    spawn.parent.mkdir(parents=True)
    spawn.write_bytes(b"\x7fELF-stand-in")
    return source, spawn


class BundleIdentityTest(unittest.TestCase):
    def test_identical_sources_produce_an_identical_bundle_digest(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source, spawn = _sample_tree(root)
            first = build_src_snapshot(source, root / "first.tar", spawn)
            second = build_src_snapshot(source, root / "second.tar", spawn)
            self.assertTrue(first.bundle_sha256)
            self.assertEqual(first.bundle_sha256, second.bundle_sha256)

    def test_a_source_edit_changes_the_bundle_digest(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source, spawn = _sample_tree(root)
            before = build_src_snapshot(source, root / "before.tar", spawn)
            (source / "runtime" / "agent.mjs").write_text(
                "export const agent = 2;\n", encoding="utf-8"
            )
            after = build_src_snapshot(source, root / "after.tar", spawn)
            self.assertNotEqual(before.bundle_sha256, after.bundle_sha256)

    def test_manifest_digests_every_bundled_file(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source, spawn = _sample_tree(root)
            snapshot = build_src_snapshot(source, root / "bundle.tar", spawn)
            manifest = bundle_manifest(snapshot, "spawn-source-digest")

            self.assertEqual(manifest["bundleSha256"], snapshot.bundle_sha256)
            self.assertEqual(manifest["spawnSha256"], "spawn-source-digest")
            self.assertEqual(manifest["fileCount"], 3)
            self.assertEqual(
                manifest["totalBytes"],
                sum(int(entry["size"]) for entry in manifest["files"]),
            )

            on_disk = {
                "src/cli.mjs": source / "cli.mjs",
                "src/runtime/agent.mjs": source / "runtime" / "agent.mjs",
                "native-tools/mixdog-spawn": spawn,
            }
            self.assertEqual(
                {str(entry["path"]) for entry in manifest["files"]}, set(on_disk)
            )
            for entry in manifest["files"]:
                expected = hashlib.sha256(
                    on_disk[str(entry["path"])].read_bytes()
                ).hexdigest()
                self.assertEqual(entry["sha256"], expected, entry["path"])


if __name__ == "__main__":
    unittest.main()
