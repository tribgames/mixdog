"""Fail-closed discovery and immutable snapshotting for the bench src overlay."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


STATIC_SRC_OVERLAY_FILES = (
    "runtime/agent/orchestrator/context/collect.mjs",
    "rules/lead/lead-tool.md",
    "rules/lead/lead-brief.md",
    "runtime/agent/orchestrator/session/loop/steering-ladder.mjs",
    "runtime/agent/orchestrator/session/manager/runtime-liveness.mjs",
    "runtime/agent/orchestrator/providers/openai-ws-stream.mjs",
    "runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs",
    "runtime/agent/orchestrator/session/context-utils.mjs",
    "runtime/agent/orchestrator/session/loop/compact-policy.mjs",
    "runtime/agent/orchestrator/session/manager/compaction-runner.mjs",
    "runtime/agent/orchestrator/session/pre-send-compact.mjs",
    "runtime/agent/orchestrator/providers/anthropic.mjs",
    "runtime/agent/orchestrator/providers/anthropic-oauth.mjs",
    "runtime/agent/orchestrator/providers/anthropic-oauth-credentials.mjs",
    "runtime/agent/orchestrator/session/agent-loop.mjs",
    "runtime/agent/orchestrator/session/loop/termination.mjs",
    "runtime/agent/orchestrator/session/manager/ask-session.mjs",
    "runtime/agent/orchestrator/session/send-with-recovery.mjs",
    "runtime/agent/orchestrator/tools/shell-command.mjs",
    "runtime/agent/orchestrator/tools/builtin/bash-tool.mjs",
    "runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs",
    "rules/shared/01-tool.md",
    "agents/reviewer/AGENT.md",
)
SNAPSHOT_MANIFEST = "manifest.json"
SNAPSHOT_FILES_DIR = "files"
SNAPSHOT_ENV = "MIXDOG_TB_SRC_SNAPSHOT"


class SrcOverlayError(RuntimeError):
    """The local source overlay cannot be proven complete and safe."""


@dataclass(frozen=True)
class SnapshotEntry:
    index: int
    path: str
    mode: int
    size: int
    sha256: str


@dataclass(frozen=True)
class SrcSnapshot:
    root: Path
    entries: tuple[SnapshotEntry, ...]

    @property
    def manifest_path(self) -> Path:
        return self.root / SNAPSHOT_MANIFEST

    def file_path(self, entry: SnapshotEntry) -> Path:
        return self.root / SNAPSHOT_FILES_DIR / Path(*entry.path.split("/"))


def _stat_identity(info: os.stat_result) -> tuple[int, ...]:
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def _validate_relative_path(path: str, *, git_path: bool) -> str:
    if not isinstance(path, str) or not path:
        raise SrcOverlayError(f"invalid empty src overlay path: {path!r}")
    if "\\" in path:
        raise SrcOverlayError(f"src overlay path must use '/' separators: {path!r}")
    parts = path.split("/")
    if path.startswith("/") or any(part in ("", ".", "..") for part in parts):
        raise SrcOverlayError(f"src overlay path escapes its root: {path!r}")
    if git_path:
        if len(parts) < 2 or parts[0] != "src":
            raise SrcOverlayError(f"Git returned a non-src overlay path: {path!r}")
        parts = parts[1:]
    try:
        path.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise SrcOverlayError(f"src overlay path is not valid Unicode: {path!r}") from exc
    return "/".join(parts)


def _path_order(path: str) -> bytes:
    return path.encode("utf-8")


def discover_git_src_files(repo_root: Path) -> tuple[str, ...]:
    """Return ordinary modified/added/type-changed and untracked src files."""
    command = [
        "git",
        "--literal-pathspecs",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        "src/",
    ]
    try:
        result = subprocess.run(
            command,
            cwd=repo_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as exc:
        raise SrcOverlayError(f"cannot discover local src changes with Git: {exc}") from exc
    if result.returncode != 0:
        detail = os.fsdecode(result.stderr).strip() or f"exit {result.returncode}"
        raise SrcOverlayError(f"Git src change discovery failed: {detail}")
    if result.stdout and not result.stdout.endswith(b"\0"):
        raise SrcOverlayError("Git src change discovery returned truncated porcelain data")

    records = result.stdout.split(b"\0")
    if records and records[-1] == b"":
        records.pop()
    discovered: set[str] = set()
    for record in records:
        if len(record) < 4 or record[2:3] != b" ":
            raise SrcOverlayError("Git src change discovery returned malformed porcelain data")
        try:
            status_code = record[:2].decode("ascii")
        except UnicodeDecodeError as exc:
            raise SrcOverlayError("Git src change discovery returned an invalid status") from exc
        current_path = os.fsdecode(record[3:])
        relative = _validate_relative_path(current_path, git_path=True)
        if status_code == "??":
            discovered.add(relative)
            continue
        if status_code == "!!" or any(
            code not in " MADRCUT" for code in status_code
        ):
            raise SrcOverlayError(
                f"Git src change discovery returned invalid status {status_code!r}"
            )
        if "R" in status_code or "C" in status_code:
            raise SrcOverlayError(
                f"rename/copy src changes are not safely modeled: {current_path!r}"
            )
        if "D" in status_code:
            raise SrcOverlayError(
                f"deleted src changes are not safely modeled: {current_path!r}"
            )
        if "U" in status_code or status_code in {"AA", "DD", "AU", "UA", "DU", "UD"}:
            raise SrcOverlayError(f"unmerged src path: {current_path!r}")
        if "T" in status_code:
            raise SrcOverlayError(f"unsupported src type change: {current_path!r}")
        if status_code == "  " or not any(code in "MA" for code in status_code):
            raise SrcOverlayError(
                f"Git src change discovery returned malformed status {status_code!r}"
            )
        discovered.add(relative)
    return tuple(sorted(discovered, key=_path_order))


def _discover_git_index_modes(repo_root: Path) -> dict[str, int]:
    command = [
        "git",
        "--literal-pathspecs",
        "ls-files",
        "--stage",
        "-z",
        "--",
        "src/",
    ]
    try:
        result = subprocess.run(
            command,
            cwd=repo_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as exc:
        raise SrcOverlayError(f"cannot discover Git src modes: {exc}") from exc
    if result.returncode != 0:
        detail = os.fsdecode(result.stderr).strip() or f"exit {result.returncode}"
        raise SrcOverlayError(f"Git src mode discovery failed: {detail}")
    if result.stdout and not result.stdout.endswith(b"\0"):
        raise SrcOverlayError("Git src mode discovery returned truncated data")
    modes: dict[str, int] = {}
    for record in result.stdout.split(b"\0"):
        if not record:
            continue
        try:
            metadata, raw_path = record.split(b"\t", 1)
            mode_raw, object_id, stage_raw = metadata.split(b" ")
            mode_text = mode_raw.decode("ascii")
            stage = int(stage_raw)
            if (
                len(mode_text) != 6
                or any(character not in "01234567" for character in mode_text)
                or len(object_id) < 4
                or stage != 0
            ):
                raise ValueError
        except (ValueError, UnicodeDecodeError) as exc:
            raise SrcOverlayError("Git src mode discovery returned malformed data") from exc
        relative = _validate_relative_path(os.fsdecode(raw_path), git_path=True)
        if relative in modes:
            raise SrcOverlayError(f"duplicate Git src mode entry: {relative!r}")
        modes[relative] = int(mode_text, 8)
    return modes


def collect_src_overlay_files(
    static_files: Iterable[str], repo_src: Path
) -> tuple[str, ...]:
    """Build the deterministic static + working-tree path union."""
    try:
        resolved_src = repo_src.resolve(strict=True)
    except OSError as exc:
        raise SrcOverlayError(f"cannot resolve repository src root {repo_src}: {exc}") from exc
    if not resolved_src.is_dir():
        raise SrcOverlayError(f"repository src root is not a directory: {repo_src}")
    normalized_static = {
        _validate_relative_path(path, git_path=False) for path in static_files
    }
    return tuple(
        sorted(
            normalized_static.union(discover_git_src_files(resolved_src.parent)),
            key=_path_order,
        )
    )


def _open_stable_regular_file(path: Path):
    """Open one source without following a raced final symlink."""
    try:
        before = os.lstat(path)
    except OSError as exc:
        raise SrcOverlayError(f"required src overlay file is unavailable: {path}") from exc
    if not stat.S_ISREG(before.st_mode):
        raise SrcOverlayError(f"refusing non-regular src overlay file: {path}")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise SrcOverlayError(f"cannot safely open src overlay file: {path}") from exc
    after = os.fstat(descriptor)
    if (
        not stat.S_ISREG(before.st_mode)
        or not stat.S_ISREG(after.st_mode)
        or not os.path.samestat(before, after)
    ):
        os.close(descriptor)
        raise SrcOverlayError(f"src overlay file changed during snapshot: {path}")
    return os.fdopen(descriptor, "rb")


def build_src_snapshot(
    static_files: Iterable[str], repo_src: Path, output_root: Path
) -> SrcSnapshot:
    """Synchronously freeze validated source bytes and their size/hash manifest."""
    normalized_static = {
        _validate_relative_path(path, git_path=False) for path in static_files
    }
    try:
        resolved_src = repo_src.resolve(strict=True)
        repo_root = resolved_src.parent
        changed_before = discover_git_src_files(repo_root)
        modes_before = _discover_git_index_modes(repo_root)
        overlay = tuple(
            sorted(normalized_static.union(changed_before), key=_path_order)
        )
        output_root.mkdir(parents=True, exist_ok=False)
        files_root = output_root / SNAPSHOT_FILES_DIR
        files_root.mkdir()
        entries: list[SnapshotEntry] = []
        source_identities: dict[str, tuple[int, ...]] = {}
        for index, relative in enumerate(overlay):
            source = resolved_src.joinpath(*relative.split("/"))
            resolved_source = source.resolve(strict=True)
            expected_source = os.lstat(resolved_source)
            try:
                resolved_source.relative_to(resolved_src)
            except ValueError as exc:
                raise SrcOverlayError(
                    f"src overlay path escapes src root: {relative!r}"
                ) from exc
            destination = files_root.joinpath(*relative.split("/"))
            destination.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            size = 0
            with _open_stable_regular_file(source) as source_file:
                opened_source = os.fstat(source_file.fileno())
                if _stat_identity(opened_source) != _stat_identity(expected_source):
                    raise SrcOverlayError(
                        f"src overlay path changed before snapshot: {relative!r}"
                    )
                with destination.open("xb") as destination_file:
                    while chunk := source_file.read(1024 * 1024):
                        destination_file.write(chunk)
                        digest.update(chunk)
                        size += len(chunk)
                final_source = os.fstat(source_file.fileno())
                try:
                    final_path = os.lstat(source)
                    final_resolved = source.resolve(strict=True)
                except OSError as exc:
                    raise SrcOverlayError(
                        f"src overlay path changed during snapshot: {relative!r}"
                    ) from exc
                if (
                    _stat_identity(final_source) != _stat_identity(opened_source)
                    or _stat_identity(final_path) != _stat_identity(opened_source)
                    or final_resolved != resolved_source
                    or size != opened_source.st_size
                ):
                    raise SrcOverlayError(
                        f"src overlay file changed during snapshot: {relative!r}"
                    )
            index_mode = modes_before.get(relative)
            if index_mode is not None and index_mode not in {0o100644, 0o100755}:
                raise SrcOverlayError(
                    f"unsupported Git src file type/mode {index_mode:o}: {relative!r}"
                )
            executable = bool(stat.S_IMODE(opened_source.st_mode) & 0o111)
            if os.name == "nt" and index_mode is not None:
                # Windows cannot represent POSIX execute bits in st_mode; the
                # Git index remains authoritative for tracked files.
                executable = index_mode == 0o100755
            file_mode = 0o755 if executable else 0o644
            source_identities[relative] = _stat_identity(opened_source)
            entries.append(
                SnapshotEntry(index, relative, file_mode, size, digest.hexdigest())
            )
        for relative in overlay:
            source = resolved_src.joinpath(*relative.split("/"))
            try:
                final_identity = _stat_identity(os.lstat(source))
                final_resolved = source.resolve(strict=True)
            except OSError as exc:
                raise SrcOverlayError(
                    f"src overlay path changed after snapshot copy: {relative!r}"
                ) from exc
            if (
                final_identity != source_identities[relative]
                or final_resolved != source
            ):
                raise SrcOverlayError(
                    f"src overlay file changed after snapshot copy: {relative!r}"
                )
        changed_after = discover_git_src_files(repo_root)
        modes_after = _discover_git_index_modes(repo_root)
        if changed_after != changed_before:
            raise SrcOverlayError("Git src path set changed during immutable snapshot")
        relevant_modes_before = {
            path: modes_before.get(path) for path in overlay
        }
        relevant_modes_after = {
            path: modes_after.get(path) for path in overlay
        }
        if relevant_modes_after != relevant_modes_before:
            raise SrcOverlayError("Git src mode/type changed during immutable snapshot")
        document = {
            "schemaVersion": 2,
            "files": [
                {
                    "index": entry.index,
                    "path": entry.path,
                    "mode": entry.mode,
                    "size": entry.size,
                    "sha256": entry.sha256,
                }
                for entry in entries
            ],
        }
        manifest_path = output_root / SNAPSHOT_MANIFEST
        manifest_path.write_text(
            json.dumps(document, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        for path in [manifest_path, *(files_root.rglob("*"))]:
            if path.is_file():
                path.chmod(stat.S_IREAD)
        for path in sorted(
            (item for item in output_root.rglob("*") if item.is_dir()),
            key=lambda item: len(item.parts),
            reverse=True,
        ):
            path.chmod(stat.S_IREAD | stat.S_IEXEC)
        output_root.chmod(stat.S_IREAD | stat.S_IEXEC)
        return SrcSnapshot(output_root, tuple(entries))
    except SrcOverlayError:
        raise
    except OSError as exc:
        raise SrcOverlayError(f"cannot build immutable src snapshot: {exc}") from exc


def load_src_snapshot(root: Path) -> SrcSnapshot:
    """Validate a prebuilt snapshot and all frozen bytes before upload."""
    try:
        document = json.loads((root / SNAPSHOT_MANIFEST).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SrcOverlayError(f"cannot read src snapshot manifest at {root}: {exc}") from exc
    if (
        not isinstance(document, dict)
        or set(document) != {"schemaVersion", "files"}
        or document["schemaVersion"] != 2
        or not isinstance(document["files"], list)
    ):
        raise SrcOverlayError("invalid src snapshot manifest")
    entries: list[SnapshotEntry] = []
    for expected_index, item in enumerate(document["files"]):
        if not isinstance(item, dict) or set(item) != {
            "index",
            "path",
            "mode",
            "size",
            "sha256",
        }:
            raise SrcOverlayError("invalid src snapshot manifest entry")
        relative = _validate_relative_path(item["path"], git_path=False)
        if (
            item["index"] != expected_index
            or not isinstance(item["mode"], int)
            or item["mode"] not in {0o644, 0o755}
            or
            not isinstance(item["size"], int)
            or item["size"] < 0
            or not isinstance(item["sha256"], str)
            or len(item["sha256"]) != 64
            or any(character not in "0123456789abcdef" for character in item["sha256"])
        ):
            raise SrcOverlayError(f"invalid src snapshot metadata: {relative!r}")
        entry = SnapshotEntry(
            item["index"], relative, item["mode"], item["size"], item["sha256"]
        )
        path = root / SNAPSHOT_FILES_DIR / Path(*relative.split("/"))
        digest = hashlib.sha256()
        size = 0
        with _open_stable_regular_file(path) as snapshot_file:
            opened_snapshot = os.fstat(snapshot_file.fileno())
            while chunk := snapshot_file.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
            final_snapshot = os.fstat(snapshot_file.fileno())
        if (
            _stat_identity(opened_snapshot) != _stat_identity(final_snapshot)
            or size != entry.size
            or digest.hexdigest() != entry.sha256
        ):
            raise SrcOverlayError(f"src snapshot content mismatch: {relative!r}")
        entries.append(entry)
    paths = [entry.path for entry in entries]
    if len(paths) != len(set(paths)):
        raise SrcOverlayError("src snapshot paths are not unique")
    if paths != sorted(paths, key=_path_order):
        raise SrcOverlayError("src snapshot paths do not follow manifest byte order")
    return SrcSnapshot(root, tuple(entries))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    repo_src = Path(__file__).resolve().parents[3] / "src"
    try:
        build_src_snapshot(STATIC_SRC_OVERLAY_FILES, repo_src, args.output)
    except SrcOverlayError as exc:
        print(f"src overlay preflight failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
