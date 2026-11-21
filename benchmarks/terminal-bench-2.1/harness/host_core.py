"""The user's own running mixdog core, as the launcher and the agent find it."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Callable, Mapping

# `_CS_DARWIN_USER_TEMP_DIR` of <unistd.h>; Python's table names it only on some builds.
_DARWIN_USER_TEMP_DIR = 65537


def _darwin_user_temp_dir() -> str | None:
    try:
        return os.confstr(os.confstr_names.get("CS_DARWIN_USER_TEMP_DIR", _DARWIN_USER_TEMP_DIR))
    except (OSError, ValueError, AttributeError):
        return None


def rust_temp_dir(
    environ: Mapping[str, str] = os.environ,
    platform: str = sys.platform,
    darwin_user_temp_dir: Callable[[], str | None] = _darwin_user_temp_dir,
) -> Path:
    """Rust's std::env::temp_dir(): on Windows GetTempPath2's order (TMP,
    TEMP, USERPROFILE, the Windows directory); elsewhere TMPDIR when it is set
    (even empty), else Darwin's per-user directory (confstr
    _CS_DARWIN_USER_TEMP_DIR) on Apple targets, else /tmp."""
    if platform == "win32":
        for name in ("TMP", "TEMP", "USERPROFILE"):
            if environ.get(name):
                return Path(environ[name])
        return Path(environ.get("SystemRoot") or r"C:\Windows")
    if "TMPDIR" in environ:
        return Path(environ["TMPDIR"])
    if platform == "darwin":
        return Path(darwin_user_temp_dir() or "/tmp")
    return Path("/tmp")


def runtime_root(
    environ: Mapping[str, str] = os.environ,
    platform: str = sys.platform,
    darwin_user_temp_dir: Callable[[], str | None] = _darwin_user_temp_dir,
) -> Path:
    """The running core's runtime root, as mixdog's clients find it
    (mixdog-app-server-client discovery::runtime_root): MIXDOG_RUNTIME_ROOT
    when not empty, else <tmp>/mixdog on Windows and <tmp>/mixdog-<uid>
    elsewhere, with <tmp> [`rust_temp_dir`].
    """
    explicit = environ.get("MIXDOG_RUNTIME_ROOT")
    if explicit:
        return Path(explicit)
    tmp = rust_temp_dir(environ, platform, darwin_user_temp_dir)
    if platform == "win32":
        return tmp / "mixdog"
    return tmp / f"mixdog-{os.getuid()}"


if __name__ == "__main__":
    sys.stdout.write(f"{runtime_root()}\n")
