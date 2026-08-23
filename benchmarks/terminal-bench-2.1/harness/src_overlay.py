"""Immutable local runtime bundles used by Terminal-Bench."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


SNAPSHOT_ENV = "MIXDOG_TB_SRC_SNAPSHOT"
ARCHIVE_ROOT = "src"
NATIVE_ROOT = "native-tools"
SPAWN_MEMBER = f"{NATIVE_ROOT}/mixdog-spawn"
REQUIRED_SPAWN_CAPS = ("trackedForeground", "promoteTask", "cancelOwner", "fileCapture")
SPAWN_BUILD_IMAGE = "rust:1.89-alpine3.22"
SPAWN_PROBE_IMAGE = "alpine:3.20"


def spawn_capability_shell(binary_expr: str) -> str:
    """POSIX probe that the native spawn binary exposes the required caps."""
    caps = " ".join(REQUIRED_SPAWN_CAPS)
    return (
        f'READY="$(printf \'\' | {binary_expr})"; '
        "printf '%s\\n' \"$READY\" | grep -q '\"ready\":true'; "
        f"for cap in {caps}; do "
        "printf '%s\\n' \"$READY\" | grep -q \"\\\"$cap\\\":true\"; "
        "done"
    )


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


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _spawn_source_digest(spawn_source: Path) -> str:
    digest = hashlib.sha256()
    try:
        entries = sorted(
            spawn_source.rglob("*"),
            key=lambda path: _path_order(path.relative_to(spawn_source).as_posix()),
        )
    except OSError as exc:
        raise SrcOverlayError(f"cannot enumerate native spawn source: {exc}") from exc
    for source in entries:
        relative = source.relative_to(spawn_source)
        if relative.parts and relative.parts[0] == "target":
            continue
        try:
            info = os.lstat(source)
        except OSError as exc:
            raise SrcOverlayError(f"cannot inspect native spawn source {source}: {exc}") from exc
        if stat.S_ISLNK(info.st_mode):
            raise SrcOverlayError(f"refusing symlink in native spawn source: {source}")
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            raise SrcOverlayError(f"refusing unsupported native spawn source: {source}")
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(stat.S_IMODE(info.st_mode)).encode("ascii"))
        digest.update(b"\0")
        with source.open("rb") as content:
            while chunk := content.read(1024 * 1024):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def _docker_mount(path: Path) -> str:
    return path.resolve().as_posix()


def _run_docker(arguments: list[str], label: str) -> None:
    try:
        result = subprocess.run(
            ["docker", *arguments],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError as exc:
        raise SrcOverlayError(f"{label} could not start Docker: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or f"exit {result.returncode}").strip()
        raise SrcOverlayError(f"{label} failed: {detail[-4000:]}")


def _spawn_capability_probe(binary_path: Path) -> None:
    command = (
        "set -eu; "
        "cp /runtime/mixdog-spawn-linux-x64 /tmp/mixdog-spawn; "
        "chmod 0755 /tmp/mixdog-spawn; "
        f"{spawn_capability_shell('/tmp/mixdog-spawn')}"
    )
    _run_docker(
        [
            "run",
            "--rm",
            "-v",
            f"{_docker_mount(binary_path.parent)}:/runtime:ro",
            SPAWN_PROBE_IMAGE,
            "sh",
            "-c",
            command,
        ],
        "native spawn capability preflight",
    )


def build_local_spawn(repo_root: Path, build_dir: Path) -> Path:
    """Build or reuse the current Linux spawn binary outside the prebake cache."""
    spawn_source = repo_root / "native" / "mixdog-spawn"
    source_digest = _spawn_source_digest(spawn_source)
    build_dir.mkdir(parents=True, exist_ok=True)
    binary_path = build_dir / "mixdog-spawn-linux-x64"
    manifest_path = build_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        manifest = {}
    if (
        binary_path.is_file()
        and manifest.get("schemaVersion") == 1
        and manifest.get("sourceSha256") == source_digest
        and manifest.get("binarySha256") == _sha256_file(binary_path)
    ):
        try:
            _spawn_capability_probe(binary_path)
            return binary_path
        except SrcOverlayError:
            pass

    temporary = Path(tempfile.mkdtemp(prefix=".spawn-build-", dir=build_dir))
    try:
        command = (
            "set -eu; "
            "apk add --no-cache musl-dev >/dev/null; "
            "CARGO_TARGET_DIR=/tmp/target cargo build --locked --release "
            "--manifest-path /src/Cargo.toml; "
            "BINARY=/tmp/target/release/mixdog-spawn; "
            + spawn_capability_shell('"$BINARY"') + "; " +
            "install -m 0755 \"$BINARY\" /out/mixdog-spawn-linux-x64"
        )
        _run_docker(
            [
                "run",
                "--rm",
                "-v",
                f"{_docker_mount(spawn_source)}:/src:ro",
                "-v",
                f"{_docker_mount(temporary)}:/out",
                SPAWN_BUILD_IMAGE,
                "sh",
                "-c",
                command,
            ],
            "local native spawn build",
        )
        candidate = temporary / binary_path.name
        if not candidate.is_file() or candidate.stat().st_size == 0:
            raise SrcOverlayError("local native spawn build produced no binary")
        binary_digest = _sha256_file(candidate)
        candidate.replace(binary_path)
        manifest_temp = temporary / "manifest.json"
        manifest_temp.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "sourceSha256": source_digest,
                    "binarySha256": binary_digest,
                    "requiredCaps": list(REQUIRED_SPAWN_CAPS),
                    "buildImage": SPAWN_BUILD_IMAGE,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        manifest_temp.replace(manifest_path)
        _spawn_capability_probe(binary_path)
        return binary_path
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


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
                relative_name = "/".join(parts)
                entries.append(
                    _SourceEntry(
                        source,
                        archive_name,
                        (
                            0o755
                            if relative_name == "cli.mjs"
                            else (
                                tracked_modes.get(relative_name, 0o644)
                                if os.name == "nt"
                                else stat.S_IMODE(info.st_mode)
                            )
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


def build_src_snapshot(
    repo_src: Path, output_path: Path, spawn_binary: Path
) -> SrcSnapshot:
    """Capture current source and its matching native spawn binary."""
    try:
        spawn_info = os.lstat(spawn_binary)
    except OSError as exc:
        raise SrcOverlayError(f"cannot inspect local native spawn binary: {exc}") from exc
    if stat.S_ISLNK(spawn_info.st_mode) or not stat.S_ISREG(spawn_info.st_mode):
        raise SrcOverlayError(f"local native spawn binary is not a regular file: {spawn_binary}")
    if spawn_info.st_size == 0:
        raise SrcOverlayError(f"local native spawn binary is empty: {spawn_binary}")
    entries = (
        *_collect_source_entries(repo_src, _git_index_file_modes(repo_src)),
        _SourceEntry(spawn_binary.parent, NATIVE_ROOT, 0o755, 0, True),
        _SourceEntry(spawn_binary, SPAWN_MEMBER, 0o755, spawn_info.st_size, False),
    )
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
    if not parts or parts[0] not in {ARCHIVE_ROOT, NATIVE_ROOT}:
        raise SrcOverlayError(f"runtime snapshot path is outside its roots: {name!r}")
    if parts[0] == NATIVE_ROOT and name not in {NATIVE_ROOT, SPAWN_MEMBER}:
        raise SrcOverlayError(f"unsupported runtime native path: {name!r}")
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
            modes: dict[str, int] = {}
            sizes: dict[str, int] = {}
            ordered_names: list[str] = []
            for member in members:
                parts = _validate_archive_name(member.name)
                if member.name in names:
                    raise SrcOverlayError(f"duplicate src snapshot path: {member.name!r}")
                names.add(member.name)
                ordered_names.append(member.name)
                modes[member.name] = member.mode
                sizes[member.name] = member.size
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
            if kinds.get(NATIVE_ROOT) != "directory":
                raise SrcOverlayError("runtime snapshot does not contain native-tools")
            if kinds.get(SPAWN_MEMBER) != "file" or sizes.get(SPAWN_MEMBER, 0) == 0:
                raise SrcOverlayError("runtime snapshot does not contain native spawn")
            if modes.get(SPAWN_MEMBER, 0) & 0o111 == 0:
                raise SrcOverlayError("runtime snapshot native spawn is not executable")
    except SrcOverlayError:
        raise
    except (OSError, tarfile.TarError, EOFError) as exc:
        raise SrcOverlayError(f"cannot read src snapshot {archive_path}: {exc}") from exc
    return SrcSnapshot(archive_path, tuple(ordered_names))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--spawn-binary", type=Path)
    args = parser.parse_args(argv)
    repo_root = Path(__file__).resolve().parents[3]
    repo_src = repo_root / "src"
    try:
        spawn_binary = args.spawn_binary or build_local_spawn(
            repo_root, Path(__file__).resolve().parents[1] / ".runtime-build"
        )
        snapshot = build_src_snapshot(repo_src, args.output, spawn_binary)
    except SrcOverlayError as exc:
        print(f"runtime bundle preflight failed: {exc}", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "runtimeBundle": str(snapshot.archive_path),
                "spawnSha256": _sha256_file(spawn_binary),
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
