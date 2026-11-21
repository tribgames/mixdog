"""The core every trial installs: the staged Linux bundle, and the prebake built from it."""

from __future__ import annotations

import functools
import hashlib
import json
import os
import sys
from pathlib import Path

PREBAKE_DIR = Path(__file__).resolve().parents[1] / "mixdog-prebake"
CORE_BUNDLE_ENV = "MIXDOG_TB_CORE_BUNDLE"
DEFAULT_CORE_BUNDLE = PREBAKE_DIR / "mixdogd-linux-x64.tgz"
PREBAKE_TAR_ENV = "MIXDOG_TB_PREBAKE_TAR"
DEFAULT_PREBAKE_TAR = PREBAKE_DIR / "mixdog-core-prebake.tar.gz"


class TrialCoreError(RuntimeError):
    pass


@functools.lru_cache(maxsize=8)
def _sha256_of(path: str, size: int, mtime_ns: int) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _sha256(path: Path) -> str:
    # Every trial's install asks again; the bundle is hashed once per version of the file.
    stat = path.stat()
    return _sha256_of(str(path.resolve()), stat.st_size, stat.st_mtime_ns)


def trial_core(environ: dict[str, str] | os._Environ = os.environ) -> dict:
    """The bundle's path and sha256. A trial installs the prebake when one
    exists (apt images) and the bundle otherwise, so a prebake counts only when
    its stamp names this very bundle: one core identity for every trial."""
    bundle = Path(environ.get(CORE_BUNDLE_ENV) or DEFAULT_CORE_BUNDLE)
    if not bundle.is_file():
        raise TrialCoreError(
            f"the Rust core bundle is missing at {bundle}; build it with harness/prebake-rust.ps1"
        )
    sha256 = _sha256(bundle)
    prebake = Path(environ.get(PREBAKE_TAR_ENV) or DEFAULT_PREBAKE_TAR)
    if prebake.is_file():
        stamp_path = prebake.parent / "prebake.json"
        try:
            baked = json.loads(stamp_path.read_text(encoding="utf-8-sig")).get("bundleSha256")
        except (OSError, json.JSONDecodeError) as exc:
            raise TrialCoreError(f"prebake stamp unreadable ({stamp_path}): {exc}") from exc
        if baked != sha256:
            raise TrialCoreError(
                f"the prebake {prebake} was built from core bundle {str(baked)[:12]}, "
                f"the staged bundle {bundle} is {sha256[:12]}; rebuild with harness/prebake.ps1"
            )
    return {
        "bundle": str(bundle),
        "bundleSha256": sha256,
        "prebake": str(prebake) if prebake.is_file() else None,
    }


if __name__ == "__main__":
    try:
        sys.stdout.write(json.dumps(trial_core()) + "\n")
    except TrialCoreError as exc:
        sys.stderr.write(f"{exc}\n")
        raise SystemExit(1)
