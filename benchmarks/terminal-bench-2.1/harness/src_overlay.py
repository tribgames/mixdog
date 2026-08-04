"""Immutable full-tree snapshots of the local ``src`` used by Terminal-Bench."""

from __future__ import annotations

import argparse
import os
import stat
import subprocess
import sys
import tarfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


SNAPSHOT_ENV = "MIXDOG_TB_SRC_SNAPSHOT"
ARCHIVE_ROOT = "src"


class SrcOverlayError(RuntimeError):
    """The local source tree cannot be captured or validated safely."""


@dataclass(frozen=True)
class SrcSnapshot:
    archive_path: Path
    members: tuple[str, ...]


@dataclass(frozen=True)
class _SourceEntry:
    source: Path
    archive_name: str
    mode: int
    size: int
    is_directory: bool


def _path_order(value: str) -> bytes:
    try:
        return value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise SrcOverlayError(f"src path is not valid Unicode: {value!r}") from exc


def _validate_component(name: str) -> None:
    if not name or name in {".", ".."} or "/" in name or "\\" in name:
        raise SrcOverlayError(f"unsafe src path component: {name!r}")
    _path_order(name)


def _git_index_file_modes(repo_src: Path) -> dict[str, int]:
    """Read tracked regular-file modes without using Git to select archive paths."""
    if os.name != "nt" or not (repo_src.parent / ".git").exists():
        return {}
    try:
        result = subprocess.run(
            [
                "git",
                "--literal-pathspecs",
                "ls-files",
                "--stage",
                "-z",
                "--",
                "src/",
            ],
            cwd=repo_src.parent,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as exc:
        raise SrcOverlayError(f"cannot read tracked src modes from Git: {exc}") from exc
    if result.returncode != 0:
        detail = os.fsdecode(result.stderr).strip() or f"exit {result.returncode}"
        raise SrcOverlayError(f"cannot read tracked src modes from Git: {detail}")
    if result.stdout and not result.stdout.endswith(b"\0"):
        raise SrcOverlayError("Git src mode data is truncated")

    modes: dict[str, int] = {}
    for record in result.stdout.split(b"\0"):
        if not record:
            continue
        try:
            metadata, raw_path = record.split(b"\t", 1)
            raw_mode, object_id, raw_stage = metadata.split(b" ")
            mode = int(raw_mode, 8)
            stage = int(raw_stage)
        except (ValueError, UnicodeDecodeError) as exc:
            raise SrcOverlayError("Git src mode data is malformed") from exc
        if len(object_id) < 4 or stage != 0:
            raise SrcOverlayError("Git src mode data is malformed")
        git_path = os.fsdecode(raw_path)
        if not git_path.startswith("src/"):
            raise SrcOverlayError(f"Git returned a non-src mode path: {git_path!r}")
        relative = git_path[len("src/") :]
        for component in relative.split("/"):
            _validate_component(component)
        if relative in modes:
            raise SrcOverlayError(f"duplicate Git src mode path: {relative!r}")
        if mode == 0o100755:
            modes[relative] = 0o755
        elif mode == 0o100644:
            modes[relative] = 0o644
    return modes


def _collect_source_entries(
    repo_src: Path, tracked_modes: dict[str, int]
) -> tuple[_SourceEntry, ...]:
    try:
        root_info = os.lstat(repo_src)
    except OSError as exc:
        raise SrcOverlayError(f"cannot inspect repository src root {repo_src}: {exc}") from exc
    if stat.S_ISLNK(root_info.st_mode):
        raise SrcOverlayError(f"repository src root is a symlink: {repo_src}")
    if not stat.S_ISDIR(root_info.st_mode):
        raise SrcOverlayError(f"repository src root is not a directory: {repo_src}")

    entries = [
        _SourceEntry(
            repo_src,
            ARCHIVE_ROOT,
            0o755 if os.name == "nt" else stat.S_IMODE(root_info.st_mode),
            0,
            True,
        )
    ]

    def walk(directory: Path, relative_parts: tuple[str, ...]) -> None:
        try:
            children = sorted(
                os.scandir(directory),
                key=lambda item: _path_order(item.name),
            )
        except OSError as exc:
            raise SrcOverlayError(f"cannot enumerate local src directory {directory}: {exc}") from exc
        for child in children:
            _validate_component(child.name)
            parts = (*relative_parts, child.name)
            archive_name = "/".join((ARCHIVE_ROOT, *parts))
            source = directory / child.name
            try:
                if child.is_symlink() or (
                    hasattr(child, "is_junction") and child.is_junction()
                ):
                    raise SrcOverlayError(f"refusing symlink in local src: {source}")
                info = child.stat(follow_symlinks=False)
            except OSError as exc:
                raise SrcOverlayError(f"cannot inspect local src entry {source}: {exc}") from exc
            if stat.S_ISLNK(info.st_mode):
                raise SrcOverlayError(f"refusing symlink in local src: {source}")
            if stat.S_ISDIR(info.st_mode):
                entries.append(
                    _SourceEntry(
                        source,
                        archive_name,
                        0o755 if os.name == "nt" else stat.S_IMODE(info.st_mode),
                        0,
                        True,
                    )
                )
                walk(source, parts)
            elif stat.S_ISREG(info.st_mode):
                entries.append(
                    _SourceEntry(
                        source,
                        archive_name,
                        (
                            tracked_modes.get("/".join(parts), 0o644)
                            if os.name == "nt"
                            else stat.S_IMODE(info.st_mode)
                        ),
                        info.st_size,
                        False,
                    )
                )
            else:
                raise SrcOverlayError(f"refusing unsupported local src entry: {source}")

    walk(repo_src, ())
    return tuple(entries)


def _tar_info(entry: _SourceEntry) -> tarfile.TarInfo:
    info = tarfile.TarInfo(entry.archive_name)
    info.mode = entry.mode
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    if entry.is_directory:
        info.type = tarfile.DIRTYPE
        info.size = 0
    else:
        info.type = tarfile.REGTYPE
        info.size = entry.size
    return info


def build_src_snapshot(repo_src: Path, output_path: Path) -> SrcSnapshot:
    """Capture every current local ``src`` entry into one read-only tar archive."""
    entries = _collect_source_entries(repo_src, _git_index_file_modes(repo_src))
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("xb") as output:
            with tarfile.open(
                fileobj=output,
                mode="w",
                format=tarfile.PAX_FORMAT,
            ) as archive:
                for entry in entries:
                    info = _tar_info(entry)
                    if entry.is_directory:
                        archive.addfile(info)
                    else:
                        with entry.source.open("rb") as source:
                            archive.addfile(info, source)
        output_path.chmod(stat.S_IREAD)
        return SrcSnapshot(output_path, tuple(entry.archive_name for entry in entries))
    except SrcOverlayError:
        raise
    except (OSError, tarfile.TarError) as exc:
        try:
            output_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise SrcOverlayError(f"cannot build immutable src snapshot: {exc}") from exc


def _validate_archive_name(name: str) -> tuple[str, ...]:
    if not isinstance(name, str) or not name or name.startswith("/") or "\\" in name:
        raise SrcOverlayError(f"unsafe src snapshot path: {name!r}")
    parts = PurePosixPath(name).parts
    if any(part in {"", ".", ".."} for part in parts):
        raise SrcOverlayError(f"src snapshot path escapes its root: {name!r}")
    if not parts or parts[0] != ARCHIVE_ROOT:
        raise SrcOverlayError(f"src snapshot path is outside {ARCHIVE_ROOT}/: {name!r}")
    for part in parts:
        _validate_component(part)
    if "/".join(parts) != name:
        raise SrcOverlayError(f"non-canonical src snapshot path: {name!r}")
    return parts


def load_src_snapshot(archive_path: Path) -> SrcSnapshot:
    """Validate a captured archive before its single container upload."""
    try:
        archive_info = os.lstat(archive_path)
    except OSError as exc:
        raise SrcOverlayError(f"cannot inspect src snapshot {archive_path}: {exc}") from exc
    if stat.S_ISLNK(archive_info.st_mode) or not stat.S_ISREG(archive_info.st_mode):
        raise SrcOverlayError(f"src snapshot is not a regular archive: {archive_path}")

    try:
        with tarfile.open(archive_path, mode="r:") as archive:
            members = archive.getmembers()
            names: set[str] = set()
            kinds: dict[str, str] = {}
            ordered_names: list[str] = []
            for member in members:
                parts = _validate_archive_name(member.name)
                if member.name in names:
                    raise SrcOverlayError(f"duplicate src snapshot path: {member.name!r}")
                names.add(member.name)
                ordered_names.append(member.name)
                if member.isdir():
                    kinds[member.name] = "directory"
                elif member.isfile():
                    kinds[member.name] = "file"
                    source = archive.extractfile(member)
                    if source is None:
                        raise SrcOverlayError(
                            f"cannot read src snapshot file: {member.name!r}"
                        )
                    size = 0
                    while chunk := source.read(1024 * 1024):
                        size += len(chunk)
                    if size != member.size:
                        raise SrcOverlayError(
                            f"truncated src snapshot file: {member.name!r}"
                        )
                else:
                    raise SrcOverlayError(
                        f"unsupported src snapshot entry: {member.name!r}"
                    )
                if member.mode & ~0o777:
                    raise SrcOverlayError(
                        f"unsupported src snapshot mode: {member.name!r}"
                    )
                if len(parts) > 1:
                    parent = "/".join(parts[:-1])
                    if kinds.get(parent) != "directory":
                        raise SrcOverlayError(
                            f"src snapshot parent is missing or not a directory: {parent!r}"
                        )
            if kinds.get(ARCHIVE_ROOT) != "directory":
                raise SrcOverlayError("src snapshot does not contain a src root directory")
    except SrcOverlayError:
        raise
    except (OSError, tarfile.TarError, EOFError) as exc:
        raise SrcOverlayError(f"cannot read src snapshot {archive_path}: {exc}") from exc
    return SrcSnapshot(archive_path, tuple(ordered_names))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    repo_src = Path(__file__).resolve().parents[3] / "src"
    try:
        build_src_snapshot(repo_src, args.output)
    except SrcOverlayError as exc:
        print(f"src snapshot preflight failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
