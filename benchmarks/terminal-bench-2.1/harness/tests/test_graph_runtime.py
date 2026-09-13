"""Source-bound graph builds, default bundling, and Linux search compatibility."""

from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

BENCH_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = BENCH_ROOT.parents[1]
sys.path.insert(0, str(BENCH_ROOT))

from harness import src_overlay


class GraphRuntimeTest(unittest.TestCase):
    def test_cache_tracks_source_and_binary_content_and_preserves_build_failure(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "native" / "mixdog-graph"
            source.mkdir(parents=True)
            code = source / "main.rs"
            code.write_text("first source", encoding="utf-8")
            builds = []

            def build(arguments, label, **kwargs):
                destination = next(arg[:-5] for arg in arguments if arg.endswith(":/out"))
                payload = code.read_bytes()
                (Path(destination) / "mixdog-graph-linux-x64").write_bytes(payload)
                builds.append(payload)
                return ""

            cache = root / "cache"
            with patch.object(src_overlay, "_run_docker", side_effect=build), \
                    patch.object(src_overlay, "_graph_capability_probe"):
                binary = src_overlay.build_local_graph(root, cache)
                src_overlay.build_local_graph(root, cache)
                self.assertEqual(builds, [b"first source"])
                binary.write_bytes(b"tampered binary")
                src_overlay.build_local_graph(root, cache)
                self.assertEqual(len(builds), 2)
                code.write_text("second source", encoding="utf-8")
                src_overlay.build_local_graph(root, cache)
                self.assertEqual(builds[-1], b"second source")
                self.assertEqual(len(builds), 3)
                manifest = json.loads((cache / "manifest.json").read_text(encoding="utf-8"))
                self.assertEqual(manifest["binarySha256"], hashlib.sha256(binary.read_bytes()).hexdigest())
                code.write_text("third source", encoding="utf-8")
                with patch.object(src_overlay, "_run_docker", side_effect=src_overlay.SrcOverlayError("build failed")):
                    with self.assertRaisesRegex(src_overlay.SrcOverlayError, "build failed"):
                        src_overlay.build_local_graph(root, cache)
                self.assertEqual(binary.read_bytes(), b"second source")

    def test_default_cli_bundle_contains_graph_without_an_override(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "src"
            source.mkdir()
            (source / "cli.mjs").write_text("console.log('fixture');", encoding="utf-8")
            spawn = root / "spawn"
            graph = root / "graph"
            spawn.write_bytes(b"spawn fixture")
            graph.write_bytes(b"graph fixture")
            archive = root / "snapshot.tar"
            manifest_path = root / "runtime-manifest.json"
            fake_module = root / "benchmarks" / "terminal-bench-2.1" / "harness" / "src_overlay.py"
            with patch.object(src_overlay, "__file__", str(fake_module)), \
                    patch.object(src_overlay, "build_local_graph", return_value=graph), \
                    patch.dict(os.environ, {src_overlay.GRAPH_BINARY_ENV: ""}), \
                    redirect_stdout(io.StringIO()):
                status = src_overlay.main([
                    "--output", str(archive), "--spawn-binary", str(spawn),
                    "--manifest", str(manifest_path),
                ])
            self.assertEqual(status, 0)
            snapshot = src_overlay.load_src_snapshot(archive)
            self.assertIn(src_overlay.GRAPH_MEMBER, snapshot.members)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            bundled = next(row for row in manifest["files"] if row["path"] == src_overlay.GRAPH_MEMBER)
            self.assertEqual(bundled["sha256"], hashlib.sha256(graph.read_bytes()).hexdigest())
            self.assertEqual(bundled["mode"], "0755")

    def test_linux_binary_honors_binary_text_opt_in(self):
        # build_local_graph runs the actual Linux protocol probe before returning,
        # including on a cache hit. Any build/protocol failure fails this test.
        src_overlay.build_local_graph(REPO_ROOT, BENCH_ROOT / ".runtime-build" / "graph")


if __name__ == "__main__":
    unittest.main()
