"""Read-only, content-addressed Docker cache for agent dependency archives."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

CACHE_TARGET = "/opt/mixdog-prebake-cache"
ARTIFACTS = ("mixdog-node-prebake.tar.zst", "zstd-amd64")


def cache_identity(directory: Path) -> str:
    digest = hashlib.sha256()
    for name in ARTIFACTS:
        digest.update(name.encode())
        with (directory / name).open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
    return digest.hexdigest()


def compose_config(volume: str) -> dict:
    return {
        "services": {
            "main": {
                "volumes": [{
                    "type": "volume",
                    "source": "mixdog-prebake-cache",
                    "target": CACHE_TARGET,
                    "read_only": True,
                    "volume": {"nocopy": True},
                }],
            },
        },
        "volumes": {"mixdog-prebake-cache": {"external": True, "name": volume}},
    }


def prepare(directory: Path, output: Path) -> str:
    directory = directory.resolve(strict=True)
    identity = cache_identity(directory)
    volume = f"mixdog-prebake-{identity}"
    stamp = json.loads((directory / "prebake.json").read_text(encoding="utf-8-sig"))
    # The build image is used only to copy opaque archives, never to run a task.
    image = stamp["image"]
    script = (
        'set -eu; if [ "$(cat /cache/ready 2>/dev/null || true)" != "$1" ]; then '
        'cp /source/mixdog-node-prebake.tar.zst /cache/mixdog-node-prebake.tar.zst; '
        'cp /source/zstd-amd64 /cache/zstd-amd64; '
        'chmod 0555 /cache/zstd-amd64; '
        'printf "%s" "$1" > /cache/ready; fi'
    )
    subprocess.run([
        "docker", "run", "--rm", "--network", "none",
        "--mount", f"type=bind,source={directory},target=/source,readonly",
        "--mount", f"type=volume,source={volume},target=/cache",
        image, "sh", "-c", script, "sh", identity,
    ], check=True, capture_output=True, text=True)
    output.write_text(json.dumps(compose_config(volume)), encoding="utf-8")
    return volume


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(f"prebake-cache {prepare(args.directory, args.output)}")
