"""The runtime root is found where the Rust client finds it."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

BENCH_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BENCH_ROOT))

from harness.host_core import runtime_root, rust_temp_dir


def _never() -> str | None:
    raise AssertionError("the Darwin user directory is read only without TMPDIR")


class RustTempDirTests(unittest.TestCase):
    def test_macos_without_tmpdir_uses_the_per_user_directory(self) -> None:
        user_dir = lambda: "/var/folders/xy/T/"
        self.assertEqual(rust_temp_dir({}, "darwin", user_dir), Path("/var/folders/xy/T/"))
        self.assertEqual(rust_temp_dir({}, "darwin", lambda: None), Path("/tmp"))
        self.assertEqual(rust_temp_dir({"TMPDIR": "/custom"}, "darwin", _never), Path("/custom"))

    def test_other_unix_uses_tmpdir_else_tmp(self) -> None:
        self.assertEqual(rust_temp_dir({}, "linux", _never), Path("/tmp"))
        self.assertEqual(rust_temp_dir({"TMPDIR": "/t"}, "linux", _never), Path("/t"))

    def test_windows_follows_get_temp_path_order(self) -> None:
        self.assertEqual(rust_temp_dir({"TMP": "A", "TEMP": "B"}, "win32"), Path("A"))
        self.assertEqual(rust_temp_dir({"TEMP": "B", "USERPROFILE": "C"}, "win32"), Path("B"))
        self.assertEqual(rust_temp_dir({"SystemRoot": "D"}, "win32"), Path("D"))

    @unittest.skipIf(os.name == "nt", "the uid suffix exists on Unix only")
    def test_the_root_is_the_clients(self) -> None:
        self.assertEqual(runtime_root({"MIXDOG_RUNTIME_ROOT": "/r"}, "darwin", _never), Path("/r"))
        self.assertEqual(
            runtime_root({}, "darwin", lambda: "/var/folders/xy/T"),
            Path("/var/folders/xy/T") / f"mixdog-{os.getuid()}",
        )

    def test_windows_root(self) -> None:
        self.assertEqual(runtime_root({"TMP": "A"}, "win32"), Path("A") / "mixdog")


if __name__ == "__main__":
    unittest.main()
