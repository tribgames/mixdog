"""The core identity a run records is the bundle its trials install."""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

BENCH_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BENCH_ROOT))

from harness.trial_core import TrialCoreError, trial_core


class TrialCoreTests(unittest.TestCase):
    def _env(self, root: Path, *, prebake_bundle: str | None) -> dict[str, str]:
        bundle = root / "mixdogd-linux-x64.tgz"
        bundle.write_bytes(b"core build one")
        prebake = root / "mixdog-core-prebake.tar.gz"
        if prebake_bundle is not None:
            prebake.write_bytes(b"prebake")
            (root / "prebake.json").write_text(json.dumps({"bundleSha256": prebake_bundle}), encoding="utf-8")
        return {"MIXDOG_TB_CORE_BUNDLE": str(bundle), "MIXDOG_TB_PREBAKE_TAR": str(prebake)}

    def test_the_identity_is_the_bundle_digest(self) -> None:
        sha = hashlib.sha256(b"core build one").hexdigest()
        with tempfile.TemporaryDirectory() as raw:
            core = trial_core(self._env(Path(raw), prebake_bundle=None))
            self.assertEqual((core["bundleSha256"], core["prebake"]), (sha, None))
        with tempfile.TemporaryDirectory() as raw:
            core = trial_core(self._env(Path(raw), prebake_bundle=sha))
            self.assertEqual(core["bundleSha256"], sha)
            self.assertTrue(core["prebake"])

    def test_a_prebake_of_another_build_of_the_bundle_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            env = self._env(Path(raw), prebake_bundle=hashlib.sha256(b"core build two").hexdigest())
            with self.assertRaisesRegex(TrialCoreError, "rebuild with harness/prebake.ps1"):
                trial_core(env)

    def test_a_missing_bundle_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            with self.assertRaisesRegex(TrialCoreError, "prebake-rust.ps1"):
                trial_core({"MIXDOG_TB_CORE_BUNDLE": str(Path(raw) / "absent.tgz")})


if __name__ == "__main__":
    unittest.main()
